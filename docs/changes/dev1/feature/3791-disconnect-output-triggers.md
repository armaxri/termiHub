### Added

- Workflows can be triggered **on disconnect**: a workflow runs once when a terminal session for a
  chosen saved connection ends. The trigger picks unexpected drops only (the default), user
  closes only, or any disconnect. The run has no live terminal, so it suits local-process and wait
  steps.
- Workflows can be triggered **on output match**: a workflow runs in the terminal whose visible
  output matches a plain-text or regular-expression pattern. Patterns are validated (at most 256
  characters, no nested quantifiers or backreferences), and each trigger has a cooldown (default
  10 s) and a maximum number of runs per session (default 5).
- Automatic triggers never prompt and skip instead of interrupting a workflow that is already
  running.

### Changed

- `workflows.json` moves to schema version 2. Existing workflows migrate automatically; an older
  termiHub will not overwrite the upgraded file.
