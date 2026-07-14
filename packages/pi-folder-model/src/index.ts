// pi-folder-model — a pi extension that pins the default model PER FOLDER,
// independently of pi's global `defaultModel` in settings.json.
//
// Problem: switching model with the built-in `/model` writes the GLOBAL
// default, so a new pi session started in any other folder inherits whatever
// you last picked. This extension keeps a per-folder preference instead, and
// re-applies it on every session start, so global drift never affects a folder
// that has its own pin.
//
// A FALLBACK default (the `"*"` entry, set with `/fmodel default`) covers folders
// that have NO pin: without it, an unpinned folder falls through to pi's global
// default, which is whatever you last switched to elsewhere. The fallback lands
// unpinned folders on a stable model instead of drifting with the global.
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

/**
 * Reserved registry key for the FALLBACK default, applied in any folder that has
 * no pin of its own. `resolve()` always yields an absolute path, so a real
 * folder key can never be `"*"`: it can only be written via setDefaultModel().
 *
 * Why it matters: without this default, an unpinned folder falls through to
 * pi's GLOBAL default, which is whatever model you last switched to elsewhere.
 * The `"*"` entry is this extension's own stable default, so an unpinned folder
 * lands on it instead of drifting with the global.
 */
export const DEFAULT_KEY = '*';

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

/** The fallback default (the `"*"` entry), if any. */
export function getDefaultModel(
	path = registryPath(),
): FolderModel | undefined {
	return readRegistry(path)[DEFAULT_KEY];
}

/**
 * The model to apply in `cwd`, resolving the folder pin first and the fallback
 * default second. `source` says which layer won, so callers can label the
 * status line (`folder:` vs `default:`). Returns undefined only when neither
 * layer is set (pi's own global default then stands).
 */
export function resolvePin(
	cwd: string,
	path = registryPath(),
): {pin: FolderModel; source: 'folder' | 'default'} | undefined {
	const registry = readRegistry(path);
	const folder = registry[resolve(cwd)];
	if (folder) return {pin: folder, source: 'folder'};
	const fallback = registry[DEFAULT_KEY];
	if (fallback) return {pin: fallback, source: 'default'};
	return undefined;
}

/**
 * Set (or with pin=undefined, clear) a single registry entry. Read-modify-write
 * so concurrent pi sessions writing DIFFERENT keys don't clobber each other's
 * entries. Returns the written registry.
 */
function writeEntry(
	key: string,
	pin: FolderModel | undefined,
	path: string,
): Registry {
	const registry = readRegistry(path);
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
 * Set (or with pin=undefined, clear) the entry for one folder. Folder keys are
 * normalized with resolve(). Returns the written registry.
 */
export function setFolderModel(
	cwd: string,
	pin: FolderModel | undefined,
	path = registryPath(),
): Registry {
	return writeEntry(resolve(cwd), pin, path);
}

/**
 * Set (or with pin=undefined, clear) the fallback default (the `"*"` entry).
 * Returns the written registry.
 */
export function setDefaultModel(
	pin: FolderModel | undefined,
	path = registryPath(),
): Registry {
	return writeEntry(DEFAULT_KEY, pin, path);
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

/**
 * Reflect the active layer in the status line: `folder:<model>` when the folder
 * has its own pin, `default:<model>` when it fell back to the `"*"` default,
 * blank when neither applies (pi's own global default stands).
 */
function updateStatus(
	ctx: ExtensionContext,
	resolved: {pin: FolderModel; source: 'folder' | 'default'} | undefined,
): void {
	ctx.ui.setStatus(
		'folder-model',
		resolved
			? ctx.ui.theme.fg('accent', `${resolved.source}:${resolved.pin.model}`)
			: undefined,
	);
}

/** Open a filterable selector over models that have configured auth. */
async function showModelSelector(
	ctx: ExtensionContext,
	title: string,
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
		container.addChild(new Text(theme.fg('accent', theme.bold(title))));

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

/** Parse `provider/model`; notify + return undefined on a malformed argument. */
function parsePin(ctx: ExtensionContext, arg: string): FolderModel | undefined {
	const slash = arg.indexOf('/');
	if (slash <= 0 || slash === arg.length - 1) {
		ctx.ui.notify(
			`folder-model: expected "provider/model", got "${arg}"`,
			'error',
		);
		return undefined;
	}
	return {provider: arg.slice(0, slash), model: arg.slice(slash + 1)};
}

/**
 * Persist a pin and, when it governs the current folder, apply it live. If it
 * governs here we require a successful live switch before persisting (so a pin
 * with no auth is never saved); if it does NOT govern here (e.g. setting the
 * default while this folder is pinned) we persist silently and DON'T touch the
 * running model. Status is refreshed from resolvePin either way.
 */
async function applyAndPersist(
	pi: PiLike,
	ctx: ExtensionContext,
	pin: FolderModel,
	write: (pin: FolderModel | undefined) => Registry,
	governsHere: boolean,
	path: string,
): Promise<void> {
	if (governsHere) {
		if (!(await applyPin(pi, ctx, pin, true))) return;
		write(pin);
	} else {
		write(pin);
		ctx.ui.notify(
			`default model set to ${pin.provider}/${pin.model} (this folder keeps its own pin)`,
			'info',
		);
	}
	updateStatus(ctx, resolvePin(ctx.cwd, path));
}

/**
 * Register the `/fmodel` command and the session-start apply hook.
 *
 * - `/fmodel`                       open selector, pin + apply for this folder
 * - `/fmodel provider/model`        pin + apply this folder directly
 * - `/fmodel clear`                 remove this folder's pin
 * - `/fmodel default`               open selector, set + apply the fallback
 * - `/fmodel default provider/model` set + apply the fallback directly
 * - `/fmodel default clear`         remove the fallback default
 *
 * The fallback default (the `"*"` entry) is what an unpinned folder lands on
 * instead of pi's GLOBAL default (which drifts to whatever you last picked
 * elsewhere). pi's settings.json is never touched.
 */
export default function folderModelExtension(
	pi: PiLike,
	deps: FolderModelDeps = {},
): void {
	const path = deps.registryPath ?? registryPath();

	pi.registerCommand('fmodel', {
		description: 'Pin the default model for this folder (project-local)',
		handler: async (args, ctx) => {
			let arg = args?.trim();

			// `default` subcommand: operate on the shared `"*"` fallback instead of
			// this folder. `default` can never be a valid `provider/model` (no
			// slash), so the prefix is unambiguous.
			const isDefault =
				arg === 'default' || arg?.startsWith('default ') === true;
			if (isDefault) arg = arg!.slice('default'.length).trim();

			const read = () =>
				isDefault ? getDefaultModel(path) : getFolderModel(ctx.cwd, path);
			const write = (pin: FolderModel | undefined) =>
				isDefault
					? setDefaultModel(pin, path)
					: setFolderModel(ctx.cwd, pin, path);
			const label = isDefault ? 'default model' : 'folder model';

			// Does the target we're editing actually govern THIS folder right now?
			// A folder write always does. A `default` write only governs an
			// unpinned folder: if the folder is pinned, its pin wins and setting
			// the default must NOT live-switch the model here. Live-apply is gated
			// on this so an edit to a layer that doesn't win never touches the
			// running model.
			const governsHere = () =>
				!isDefault || getFolderModel(ctx.cwd, path) === undefined;

			if (arg === 'clear') {
				const had = read() !== undefined;
				write(undefined);
				ctx.ui.notify(
					had ? `${label} removed` : `no ${label} to remove`,
					'info',
				);
				// Re-apply whatever now governs this folder (e.g. clearing a folder
				// pin may drop it onto the default), then refresh status.
				const resolved = resolvePin(ctx.cwd, path);
				if (resolved) await applyPin(pi, ctx, resolved.pin, false);
				updateStatus(ctx, resolved);
				return;
			}

			// Direct form: `provider/model`.
			if (arg) {
				const pin = parsePin(ctx, arg);
				if (!pin) return;
				await applyAndPersist(pi, ctx, pin, write, governsHere(), path);
				return;
			}

			// Selector form.
			const title = isDefault ? 'Set default model' : 'Pin folder model';
			const model = await showModelSelector(ctx, title);
			if (!model) return;
			const pin: FolderModel = {provider: model.provider, model: model.id};
			await applyAndPersist(pi, ctx, pin, write, governsHere(), path);
		},
	});

	pi.on('session_start', async (_event, ctx) => {
		const resolved = resolvePin(ctx.cwd, path);
		// Apply silently: startup already surfaces the active model. This is where
		// the fallback default bypasses pi's drifting global for unpinned folders.
		if (resolved) await applyPin(pi, ctx, resolved.pin, false);
		else
			// Neither a folder pin nor a `"*"` default: this folder is riding pi's
			// drifting global. Nudge once (info, not a warning) toward the one-time
			// fix. We DON'T auto-seed from the global, because that would just freeze
			// whatever the global drifted to, which is the very haunting we avoid.
			ctx.ui.notify(
				"folder-model: no folder pin or default set; this folder uses pi's global model. run /fmodel default to stop global drift.",
				'info',
			);
		updateStatus(ctx, resolved);
	});
}
