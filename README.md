# pi-folder-model

Pin pi's default model **per folder**, independently of the global `defaultModel`.

Switching model with pi's built-in `/model` writes the **global** default, so a new pi session started in any other folder inherits whatever you last picked. This extension keeps a **per-folder** preference instead, and re-applies it on every session start, so global drift never affects a folder that has its own pin.

## Packages

This is a pnpm workspace monorepo.

- **[`pi-folder-model`](packages/pi-folder-model)**, the pi extension. Registers the `/fmodel` command and a session-start hook that applies the folder's pinned model via pi's live `setModel` (no restart).

## How it works

- The preference lives in a single **home-level registry** at `<agentDir>/per-folder-models.json` (`~/.pi/agent/per-folder-models.json` by default; honors the `PI_AGENT_DIR` override), keyed by **absolute folder path**:

  ```json
  {
    "/home/me/dev/project-a": {"provider": "anthropic", "model": "claude-sonnet-4-5"},
    "/home/me/dev/project-b": {"provider": "openai", "model": "gpt-5.2"}
  }
  ```

- On **session start**, if the current folder has a pin, the model is applied via `pi.setModel` (live, no restart).
- `/fmodel` writes the folder's entry **and** applies the model immediately.

Keeping the state **outside** the folder means it works in untrusted/read-only projects and never pollutes a project's `.pi/`. Writes are read-modify-write on the one entry, so concurrent pi sessions pinning **different** folders do not clobber each other.

This extension **never** reads or writes pi's `settings.json`. It does not stop the built-in `/model` from updating the global default; it simply overrides that default for the current folder on startup, which is what makes global drift moot.

## Usage

Install as a pi package (add to your pi `packages`/`extensions` config), then:

- `/fmodel` — open a selector, pin + apply the chosen model for this folder
- `/fmodel anthropic/claude-sonnet-4-5` — pin + apply directly
- `/fmodel clear` — remove this folder's pin (the global default is left untouched)

A `folder:<model>` status indicator shows when the current folder is pinned.

## Develop

```sh
pnpm install
pnpm build
pnpm test
pnpm format:check
```

## License

AGPL-3.0-or-later. See [`LICENSE`](LICENSE).
