// pi-folder-model — a pi extension that pins the default model PER FOLDER,
// independently of pi's global `defaultModel` in settings.json.
//
// Problem: switching model with the built-in `/model` writes the GLOBAL
// default, so a new pi session started in any other folder inherits whatever
// you last picked. This extension keeps a per-folder preference instead, and
// re-applies it on every session start, so global drift never affects a folder
// that has its own pin.
//
// Storage: a single home-level registry at `<agentDir>/per-folder-models.json`
// (respecting the PI_AGENT_DIR override via getAgentDir()), keyed by ABSOLUTE
// folder path:
//
//   {
//     "/home/me/dev/project-a": {"provider": "anthropic", "model": "claude-sonnet-4-5"},
//     "/home/me/dev/project-b": {"provider": "openai", "model": "gpt-5.2"}
//   }
//
// Keeping the state OUTSIDE the folder means it works in untrusted/read-only
// projects and never pollutes a project's `.pi/`. This extension NEVER reads or
// writes settings.json: it simply overrides the global default for the current
// folder on startup, which is what makes global drift moot.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import type {Api, Model} from '@earendil-works/pi-ai';
import type {
	ExtensionAPI,
	ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {DynamicBorder, getAgentDir} from '@earendil-works/pi-coding-agent';
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from '@earendil-works/pi-tui';

/** A per-folder model pin: the provider + model id to apply in that folder. */
export interface FolderModel {
	provider: string;
	model: string;
}

/** The registry file: absolute folder path -> pinned model. */
export type Registry = Record<string, FolderModel>;

/** Path to the home-level registry (honors the PI_AGENT_DIR override). */
export function registryPath(): string {
	return join(getAgentDir(), 'per-folder-models.json');
}

/** Read the whole registry; returns {} on missing/corrupt file (never throws). */
export function readRegistry(path = registryPath()): Registry {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
		if (!parsed || typeof parsed !== 'object') return {};
		const out: Registry = {};
		for (const [folder, value] of Object.entries(
			parsed as Record<string, unknown>,
		)) {
			if (value && typeof value === 'object') {
				const {provider, model} = value as Partial<FolderModel>;
				if (typeof provider === 'string' && typeof model === 'string') {
					out[folder] = {provider, model};
				}
			}
		}
		return out;
	} catch (err) {
		console.error(`pi-folder-model: failed to read ${path}: ${err}`);
		return {};
	}
}

/** The pin for a folder, if any. Folder keys are normalized with resolve(). */
export function getFolderModel(
	cwd: string,
	path = registryPath(),
): FolderModel | undefined {
	return readRegistry(path)[resolve(cwd)];
}

/**
 * Set (or with pin=undefined, clear) the entry for one folder. Read-modify-write
 * so concurrent pi sessions pinning DIFFERENT folders don't clobber each other's
 * entries. Returns the written registry.
 */
export function setFolderModel(
	cwd: string,
	pin: FolderModel | undefined,
	path = registryPath(),
): Registry {
	const registry = readRegistry(path);
	const key = resolve(cwd);
	if (pin) {
		registry[key] = pin;
	} else {
		delete registry[key];
	}
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
	return registry;
}

/**
 * Injectable deps so tests can point the registry at a temp file WITHOUT the
 * real agent dir or env (mirrors pi-webveil's `deps` seam). Defaults to the
 * home-level `getAgentDir()` registry.
 */
export interface FolderModelDeps {
	registryPath?: string;
}

/** The slice of pi's extension API this extension uses. */
export interface PiLike {
	registerCommand(
		name: string,
		def: {
			description: string;
			handler: (
				args: string | undefined,
				ctx: ExtensionContext,
			) => Promise<void> | void;
		},
	): void;
	setModel(model: Model<Api>): Promise<boolean>;
	on(
		event: 'session_start',
		handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void,
	): void;
}

/**
 * Apply a pinned model if it resolves in the registry and has configured auth.
 * Returns true only when the live model was actually switched.
 */
async function applyPin(
	pi: PiLike,
	ctx: ExtensionContext,
	pin: FolderModel,
	announce: boolean,
): Promise<boolean> {
	const model = ctx.modelRegistry.find(pin.provider, pin.model);
	if (!model) {
		ctx.ui.notify(
			`folder-model: ${pin.provider}/${pin.model} not found`,
			'warning',
		);
		return false;
	}
	const success = await pi.setModel(model);
	if (!success) {
		ctx.ui.notify(
			`folder-model: no API key for ${pin.provider}/${pin.model}`,
			'warning',
		);
		return false;
	}
	if (announce)
		ctx.ui.notify(`folder model: ${pin.provider}/${pin.model}`, 'info');
	return true;
}

function updateStatus(
	ctx: ExtensionContext,
	pin: FolderModel | undefined,
): void {
	ctx.ui.setStatus(
		'folder-model',
		pin ? ctx.ui.theme.fg('accent', `folder:${pin.model}`) : undefined,
	);
}

/** Open a filterable selector over models that have configured auth. */
async function showModelSelector(
	ctx: ExtensionContext,
): Promise<Model<Api> | null> {
	const models = ctx.modelRegistry.getAvailable();
	if (models.length === 0) {
		ctx.ui.notify('folder-model: no models with configured auth', 'warning');
		return null;
	}

	const items: SelectItem[] = models.map((m) => ({
		value: `${m.provider}/${m.id}`,
		label: m.id,
		description: m.provider,
	}));

	const chosen = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
		container.addChild(
			new Text(theme.fg('accent', theme.bold('Pin folder model'))),
		);

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg('accent', text),
			selectedText: (text) => theme.fg('accent', text),
			description: (text) => theme.fg('muted', text),
			scrollInfo: (text) => theme.fg('dim', text),
			noMatch: (text) => theme.fg('warning', text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(
			new Text(
				theme.fg(
					'dim',
					'↑↓ navigate • type to filter • enter select • esc cancel',
				),
			),
		);
		container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!chosen) return null;
	return models.find((m) => `${m.provider}/${m.id}` === chosen) ?? null;
}

/**
 * Register the `/fmodel` command and the session-start apply hook.
 *
 * - `/fmodel`                    open selector, pin + apply chosen model
 * - `/fmodel provider/model`     pin + apply directly
 * - `/fmodel clear`              remove this folder's pin (global untouched)
 */
export default function folderModelExtension(
	pi: PiLike,
	deps: FolderModelDeps = {},
): void {
	const path = deps.registryPath ?? registryPath();

	pi.registerCommand('fmodel', {
		description: 'Pin the default model for this folder (project-local)',
		handler: async (args, ctx) => {
			const arg = args?.trim();

			if (arg === 'clear') {
				const had = getFolderModel(ctx.cwd, path) !== undefined;
				setFolderModel(ctx.cwd, undefined, path);
				ctx.ui.notify(
					had ? 'folder model pin removed' : 'no folder model pin to remove',
					'info',
				);
				updateStatus(ctx, undefined);
				return;
			}

			// Direct form: `/fmodel provider/model`.
			if (arg) {
				const slash = arg.indexOf('/');
				if (slash <= 0 || slash === arg.length - 1) {
					ctx.ui.notify(
						`folder-model: expected "provider/model", got "${arg}"`,
						'error',
					);
					return;
				}
				const pin: FolderModel = {
					provider: arg.slice(0, slash),
					model: arg.slice(slash + 1),
				};
				if (await applyPin(pi, ctx, pin, true)) {
					setFolderModel(ctx.cwd, pin, path);
					updateStatus(ctx, pin);
				}
				return;
			}

			// Selector form.
			const model = await showModelSelector(ctx);
			if (!model) return;
			const pin: FolderModel = {provider: model.provider, model: model.id};
			if (await applyPin(pi, ctx, pin, true)) {
				setFolderModel(ctx.cwd, pin, path);
				updateStatus(ctx, pin);
			}
		},
	});

	pi.on('session_start', async (_event, ctx) => {
		const pin = getFolderModel(ctx.cwd, path);
		// Apply silently: startup already surfaces the active model.
		if (pin) await applyPin(pi, ctx, pin, false);
		updateStatus(ctx, pin);
	});
}
