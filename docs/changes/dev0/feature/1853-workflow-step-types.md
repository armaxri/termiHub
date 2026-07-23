### Added

- **Workflow Automation** (epic #1851): the remaining v1 terminal-native
  workflow step types now execute. A workflow can **`run-script`** (stream a
  saved multi-line script into the session line by line, with an optional
  per-line delay and an optional on-disk `sourcePath`), **`run-macro`** (replay
  an existing stored macro by id through the macro-playback service, reusing its
  recorded timing), and **`wait`** (pause a fixed number of milliseconds between
  steps). Script and inter-step delays are clamped to the same
  `MAX_STEP_DELAY_MS` guard macro playback uses, per-step progress and
  cancellation keep working across all kinds (a cancel aborts an in-flight
  script's remaining lines), and a mixed workflow of `send-command`,
  `run-script`, `wait`, and `run-macro` runs its steps in order. The guarded
  `run-local-process` step remains deferred to #1857. No user-facing UI yet
  (#1853).
