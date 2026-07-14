#!/usr/bin/env node
// Publish hygiene: copy the monorepo's root README.md + LICENSE into a package
// so the published tarball carries them. The copies are generated artifacts
// (gitignored in each package), NOT source. Wired into each package's `prepack`
// so it runs automatically on `npm pack` / `npm publish` / `pnpm publish`.
//
// Safety: every write stays inside the repo. The destination must resolve to a
// path under the repo root, and the assets must already exist at the repo root;
// otherwise we fail loud rather than touch some shared/global location.

import {copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

// Assets copied into each package, relative to the repo root.
export const PUBLISH_ASSETS = ['README.md', 'LICENSE'];

// GitHub repo the published README's links should resolve against.
export const GITHUB_REPO = 'wighawag/webveil';

// Repo-relative path prefixes that do NOT ship inside the npm tarball, so a
// relative link to them is dead on npmjs.com and MUST be rewritten to an
// absolute GitHub URL. (`README.md` and `LICENSE` DO ship, so they stay
// relative and keep working from the tarball.)
const NON_SHIPPED_PREFIXES = [
	'work/',
	'docs/',
	'packages/',
	'CONTEXT.md',
	'COPYRIGHT',
];

// Resolve the git ref the published README should pin its links to. Priority:
//   1. `${name}@${version}` from the package's own package.json. This repo
//      releases via Changesets, which tags each package exactly `name@version`
//      at the release commit (the tag is pushed right after publish, but the
//      name is deterministic, so the pinned link resolves once pushed).
//   2. GITHUB_SHA (CI override, e.g. GitHub Actions).
//   3. `git rev-parse HEAD` (local `npm pack` inspection).
//   4. 'main' (last-ditch fallback, with a loud warning).
export function resolvePinRef({packageDir, env = process.env} = {}) {
	if (packageDir) {
		const pkgJson = join(packageDir, 'package.json');
		if (existsSync(pkgJson)) {
			try {
				const {name, version} = JSON.parse(readFileSync(pkgJson, 'utf8'));
				if (name && version) return `${name}@${version}`;
			} catch {
				// fall through to the next strategy
			}
		}
	}
	if (env.GITHUB_SHA) return env.GITHUB_SHA;
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], {
			encoding: 'utf8',
		}).trim();
	} catch {
		// not a git checkout (e.g. some sandbox)
	}
	console.warn(
		'copy-publish-assets: could not resolve a pin ref (no package version, ' +
			'GITHUB_SHA, or git HEAD); falling back to "main". Published README ' +
			'links will NOT be pinned to this release.',
	);
	return 'main';
}

function isNonShipped(target) {
	return NON_SHIPPED_PREFIXES.some((p) => target === p || target.startsWith(p));
}

// Rewrite repo-relative Markdown links that point at files NOT shipped in the
// tarball into absolute GitHub blob URLs pinned to `ref`. Links that are
// absolute (http/https/mailto), in-page anchors (#...), or point at shipped
// assets (README.md, LICENSE) are left untouched. Pure + deterministic so it
// is unit-testable; takes and returns a string, touches no files.
export function rewriteReadmeLinks(content, {ref, repo = GITHUB_REPO} = {}) {
	if (!ref) throw new Error('rewriteReadmeLinks: a ref is required');
	// Matches the (target) part of a Markdown link: ](target). Stops at the
	// first space (so it ignores `](url "title")` titles) or closing paren.
	return content.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole; // has a scheme
		if (target.startsWith('#')) return whole; // in-page anchor
		if (target.startsWith('/')) return whole; // absolute path, leave it
		// Split off an optional in-file anchor so it survives the rewrite.
		const hashAt = target.indexOf('#');
		const path = hashAt === -1 ? target : target.slice(0, hashAt);
		const anchor = hashAt === -1 ? '' : target.slice(hashAt);
		if (!isNonShipped(path)) return whole; // shipped asset, keep relative
		return `](https://github.com/${repo}/blob/${ref}/${path}${anchor})`;
	});
}

// The repo root is the parent of the `scripts/` directory holding this file.
export function repoRoot() {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

function isInside(parent, child) {
	const rel = relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
}

// Copy the publish assets from `root` into `packageDir`. Returns the list of
// destination paths written. Throws (without writing) if a source asset is
// missing or the destination would fall outside the repo root.
export function copyPublishAssets({
	packageDir = process.cwd(),
	root = repoRoot(),
	assets = PUBLISH_ASSETS,
} = {}) {
	const absRoot = resolve(root);
	const absPackageDir = resolve(packageDir);

	if (!isInside(absRoot, absPackageDir)) {
		throw new Error(
			`copy-publish-assets: refusing to write outside the repo. ` +
				`packageDir ${absPackageDir} is not inside repo root ${absRoot}.`,
		);
	}

	// Validate every source up front so we never half-copy.
	for (const asset of assets) {
		const src = join(absRoot, asset);
		if (!existsSync(src)) {
			throw new Error(`copy-publish-assets: source asset not found: ${src}`);
		}
	}

	const pinRef = resolvePinRef({packageDir: absPackageDir});

	const written = [];
	for (const asset of assets) {
		const src = join(absRoot, asset);
		const dest = join(absPackageDir, asset);
		if (!isInside(absRoot, resolve(dest))) {
			throw new Error(
				`copy-publish-assets: refusing to write outside the repo: ${dest}`,
			);
		}
		if (asset === 'README.md') {
			// The published README must not carry repo-relative links to files
			// that aren't in the tarball (dead on npmjs.com); pin them to GitHub.
			const rewritten = rewriteReadmeLinks(readFileSync(src, 'utf8'), {
				ref: pinRef,
			});
			writeFileSync(dest, rewritten, 'utf8');
		} else {
			copyFileSync(src, dest);
		}
		written.push(dest);
	}
	return written;
}

// Run directly (e.g. from a package's `prepack`): cwd is the package dir.
const invokedDirectly =
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
	const written = copyPublishAssets();
	for (const dest of written) {
		console.log(`copy-publish-assets: wrote ${relative(repoRoot(), dest)}`);
	}
}
