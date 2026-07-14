# pi-folder-model

## 0.1.0

### Minor Changes

- e866b4e: Add a fallback default model (the `"*"` registry entry) so folders with no pin of their own stop riding pi's drifting global default. New `/fmodel default`, `/fmodel default provider/model`, and `/fmodel default clear` subcommands manage it. Setting the default live-applies only in an unpinned folder; a pinned folder keeps its own pin and is never live-switched. The status line shows `folder:<model>` for a folder pin and `default:<model>` when the fallback applies, and an unpinned folder with no default set is nudged once (info) to run `/fmodel default`.
