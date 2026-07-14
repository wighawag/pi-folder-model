# pi-folder-model

Pin pi's default model **per folder**, independently of the global `defaultModel`.

Switching model with pi's built-in `/model` writes the **global** default, so a new pi session started in any other folder inherits whatever you last picked. This extension keeps a **per-folder** preference instead, and re-applies it on every session start, so global drift never affects a folder that has its own pin.

## Install

Add the package to your pi `packages`/`extensions` config so pi loads the extension on startup. Once loaded, the `/fmodel` command is available and the folder's pin (if any) is applied automatically at session start.

## Usage

- `/fmodel` — open a selector, pin + apply the chosen model for this folder
- `/fmodel anthropic/claude-sonnet-4-5` — pin + apply directly
- `/fmodel clear` — remove this folder's pin (the global default is left untouched)
- `/fmodel default` — open a selector, set + apply the **fallback default** (used in any folder with no pin of its own)
- `/fmodel default openai/gpt-5.2` — set the fallback default directly
- `/fmodel default clear` — remove the fallback default

The status indicator shows `folder:<model>` when the folder has its own pin, or `default:<model>` when it fell back to the `"*"` default. Setting the default only live-switches the model in an **unpinned** folder; if the current folder is pinned, its own pin wins and setting the default leaves the running model untouched.

### Set the fallback default (so drift stops haunting you)

The whole reason this extension exists is that pi's global default **drifts**: it becomes whatever model you last switched to, in whatever folder. A folder pin fixes that folder, but any folder you have **not** pinned still falls through to that drifting global. Set the fallback default once, and every unpinned folder lands on it instead:

```
/fmodel default anthropic/claude-sonnet-4-5
```

With `"*"` set, an unpinned folder no longer inherits whatever you last picked elsewhere. On startup in an unpinned folder with no default set yet, the extension nudges you once (an info notification) to run `/fmodel default` for exactly this reason.

## How it works

- The preference lives in a single **home-level registry** at `<agentDir>/per-folder-models.json` (`~/.pi/agent/per-folder-models.json` by default; honors the `PI_CODING_AGENT_DIR` override), keyed by **absolute folder path**:

  ```json
  {
    "*": {"provider": "anthropic", "model": "claude-sonnet-4-5"},
    "/home/me/dev/project-a": {"provider": "anthropic", "model": "claude-sonnet-4-5"},
    "/home/me/dev/project-b": {"provider": "openai", "model": "gpt-5.2"}
  }
  ```

- The reserved `"*"` key is a **fallback default** applied in any folder that has no pin of its own. An absolute folder path can never be `"*"`, so it never collides with a real folder entry.
- On **session start**, the model is resolved in two layers: the folder's own pin first, the `"*"` default second. Whichever wins is applied via `pi.setModel` (live, no restart). If neither is set, the folder rides pi's own global default.
- `/fmodel` writes the folder's entry **and** applies the model immediately; `/fmodel default` does the same for the `"*"` fallback.

Keeping the state **outside** the folder means it works in untrusted/read-only projects and never pollutes a project's `.pi/`. Writes are read-modify-write on the one entry, so concurrent pi sessions pinning **different** folders do not clobber each other.

This extension **never** reads or writes pi's `settings.json`. It does not stop the built-in `/model` from updating the global default; it simply overrides that default for the current folder on startup, which is what makes global drift moot.

## Packages

This is a pnpm workspace monorepo.

- **[`pi-folder-model`](packages/pi-folder-model)**, the pi extension. Registers the `/fmodel` command and a session-start hook that applies the folder's pinned model via pi's live `setModel` (no restart).

## Develop

```sh
pnpm install
pnpm build
pnpm test
pnpm format:check
```

## Publishing

Releases go through [changesets](https://github.com/changesets/changesets) and npm Trusted Publishing (OIDC), so there is no `NPM_TOKEN` secret. The flow:

1. Land PRs that include a changeset (`.changeset/*.md`) on `main`.
2. The `release` workflow opens or updates a "Version Packages" PR that bumps versions and updates changelogs.
3. Merging that PR runs `changeset publish` from CI, which publishes with provenance via the registered trusted publisher.

npm ties a trusted publisher to an existing package, so the **first** publish is a one-time manual `pnpm release` from a clean checkout. After that package exists on npm, register this repo + `release.yml` as its trusted publisher in the package's npmjs.com settings, and every later release goes through the tokenless OIDC flow above.

## License

AGPL-3.0-or-later. See [`LICENSE`](LICENSE).
