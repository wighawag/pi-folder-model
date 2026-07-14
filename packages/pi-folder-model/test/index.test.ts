// Tests for pi-folder-model WITHOUT pi's runtime: the registry helpers are pure
// (temp-file backed), and the extension wiring is exercised with a fake `pi`
// (capturing registerCommand/on/setModel) and a fake `ctx` (a stub
// modelRegistry + ui that records notifications). No global model state, no
// settings.json, no network.

import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import folderModel, {
	getFolderModel,
	readRegistry,
	setFolderModel,
	type FolderModel,
} from '../src/index.js';

let dir: string;
let regPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'pi-folder-model-'));
	regPath = join(dir, 'per-folder-models.json');
});
afterEach(() => {
	rmSync(dir, {recursive: true, force: true});
});

const claude: FolderModel = {provider: 'anthropic', model: 'claude-sonnet-4-5'};
const gpt: FolderModel = {provider: 'openai', model: 'gpt-5.2'};

describe('registry helpers', () => {
	it('returns {} for a missing file', () => {
		expect(readRegistry(regPath)).toEqual({});
	});

	it('round-trips a folder pin by absolute path', () => {
		setFolderModel('/work/a', claude, regPath);
		expect(getFolderModel('/work/a', regPath)).toEqual(claude);
	});

	it('normalizes non-absolute / trailing-slash folder keys via resolve()', () => {
		setFolderModel('/work/a/', claude, regPath);
		expect(getFolderModel('/work/a', regPath)).toEqual(claude);
	});

	it('keeps distinct folders independent (no cross-clobber)', () => {
		setFolderModel('/work/a', claude, regPath);
		setFolderModel('/work/b', gpt, regPath);
		expect(getFolderModel('/work/a', regPath)).toEqual(claude);
		expect(getFolderModel('/work/b', regPath)).toEqual(gpt);
	});

	it('read-modify-write preserves OTHER folders when a concurrent writer added one', () => {
		// Session 1 loads the registry (empty), session 2 pins folder b to disk,
		// then session 1 writes folder a. Folder b must survive.
		readRegistry(regPath);
		setFolderModel('/work/b', gpt, regPath);
		setFolderModel('/work/a', claude, regPath);
		expect(readRegistry(regPath)).toEqual({'/work/a': claude, '/work/b': gpt});
	});

	it('clears a single folder without touching others', () => {
		setFolderModel('/work/a', claude, regPath);
		setFolderModel('/work/b', gpt, regPath);
		setFolderModel('/work/a', undefined, regPath);
		expect(getFolderModel('/work/a', regPath)).toBeUndefined();
		expect(getFolderModel('/work/b', regPath)).toEqual(gpt);
	});

	it('ignores corrupt JSON and malformed entries', () => {
		writeFileSync(regPath, '{ not json');
		expect(readRegistry(regPath)).toEqual({});
		writeFileSync(regPath, JSON.stringify({'/work/a': {provider: 'x'}}));
		expect(readRegistry(regPath)).toEqual({});
	});

	it('writes pretty JSON with a trailing newline', () => {
		setFolderModel('/work/a', claude, regPath);
		const raw = readFileSync(regPath, 'utf-8');
		expect(raw.endsWith('\n')).toBe(true);
		expect(raw).toContain('  "/work/a"');
	});
});

/** A model object shaped like pi-ai's Model (only fields the extension reads). */
function model(provider: string, id: string) {
	return {provider, id} as never;
}

/** Fake pi capturing the command handler, session_start hook, and setModel calls. */
function fakePi(setModelResult = true) {
	let command:
		((args: string | undefined, ctx: any) => Promise<void> | void) | undefined;
	let onSessionStart:
		((event: unknown, ctx: any) => Promise<void> | void) | undefined;
	const setModel = vi.fn(async () => setModelResult);
	const pi = {
		registerCommand(_name: string, def: {handler: typeof command}) {
			command = def.handler;
		},
		setModel,
		on(_event: string, handler: typeof onSessionStart) {
			onSessionStart = handler;
		},
	};
	return {
		pi,
		setModel,
		runCommand: (args: string | undefined, ctx: any) => command!(args, ctx),
		runSessionStart: (ctx: any) => onSessionStart!(undefined, ctx),
	};
}

/** Fake ctx: a modelRegistry over `available`, a notifying ui, and a cwd. */
function fakeCtx(cwd: string, available: {provider: string; id: string}[]) {
	const notifications: {msg: string; level: string}[] = [];
	const status: Record<string, string | undefined> = {};
	return {
		cwd,
		modelRegistry: {
			find: (provider: string, id: string) =>
				available.find((m) => m.provider === provider && m.id === id)
					? model(provider, id)
					: undefined,
			getAvailable: () => available.map((m) => model(m.provider, m.id)),
		},
		ui: {
			notify: (msg: string, level: string) => notifications.push({msg, level}),
			setStatus: (key: string, value: string | undefined) => {
				status[key] = value;
			},
			theme: {fg: (_c: string, s: string) => s, bold: (s: string) => s},
		},
		notifications,
		status,
	} as any;
}

describe('extension wiring', () => {
	// Inject the temp registry path via the extension's deps seam (no env, no
	// real agent dir).
	it('/fmodel provider/model applies live AND persists the pin', async () => {
		const {pi, setModel, runCommand} = fakePi();
		folderModel(pi, {registryPath: regPath});
		const ctx = fakeCtx('/work/a', [
			{provider: 'anthropic', id: 'claude-sonnet-4-5'},
		]);

		await runCommand('anthropic/claude-sonnet-4-5', ctx);

		expect(setModel).toHaveBeenCalledTimes(1);
		expect(getFolderModel('/work/a', regPath)).toEqual(claude);
	});

	it('does NOT persist when setModel fails (no auth)', async () => {
		const {pi, runCommand} = fakePi(false);
		folderModel(pi, {registryPath: regPath});
		const ctx = fakeCtx('/work/a', [
			{provider: 'anthropic', id: 'claude-sonnet-4-5'},
		]);

		await runCommand('anthropic/claude-sonnet-4-5', ctx);

		expect(getFolderModel('/work/a', regPath)).toBeUndefined();
		expect(ctx.notifications.some((n: any) => n.level === 'warning')).toBe(
			true,
		);
	});

	it('rejects a malformed argument', async () => {
		const {pi, setModel, runCommand} = fakePi();
		folderModel(pi, {registryPath: regPath});
		const ctx = fakeCtx('/work/a', []);
		await runCommand('no-slash', ctx);
		expect(setModel).not.toHaveBeenCalled();
		expect(ctx.notifications.some((n: any) => n.level === 'error')).toBe(true);
	});

	it('/fmodel clear removes the pin', async () => {
		setFolderModel('/work/a', claude, regPath);
		const {pi, runCommand} = fakePi();
		folderModel(pi, {registryPath: regPath});
		const ctx = fakeCtx('/work/a', []);

		await runCommand('clear', ctx);

		expect(getFolderModel('/work/a', regPath)).toBeUndefined();
	});

	it('session_start applies the folder pin when present', async () => {
		setFolderModel('/work/a', claude, regPath);
		const {pi, setModel, runSessionStart} = fakePi();
		folderModel(pi, {registryPath: regPath});
		const ctx = fakeCtx('/work/a', [
			{provider: 'anthropic', id: 'claude-sonnet-4-5'},
		]);

		await runSessionStart(ctx);

		expect(setModel).toHaveBeenCalledTimes(1);
	});

	it('session_start is a no-op (no setModel) when the folder has no pin', async () => {
		const {pi, setModel, runSessionStart} = fakePi();
		folderModel(pi, {registryPath: regPath});
		const ctx = fakeCtx('/work/unpinned', [
			{provider: 'anthropic', id: 'claude-sonnet-4-5'},
		]);

		await runSessionStart(ctx);

		expect(setModel).not.toHaveBeenCalled();
	});

	it('never touches a settings.json anywhere (only the registry file is written)', async () => {
		const {pi, runCommand} = fakePi();
		folderModel(pi, {registryPath: regPath});
		const ctx = fakeCtx('/work/a', [
			{provider: 'anthropic', id: 'claude-sonnet-4-5'},
		]);
		await runCommand('anthropic/claude-sonnet-4-5', ctx);
		// The temp dir must contain the registry and nothing named settings.json.
		expect(() => readFileSync(join(dir, 'settings.json'), 'utf-8')).toThrow();
		expect(readRegistry(regPath)).toEqual({'/work/a': claude});
	});
});
