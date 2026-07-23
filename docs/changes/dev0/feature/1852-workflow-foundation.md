### Added

- Groundwork for **Workflow Automation** (authored multi-step workflows, epic
  #1851): a new versioned `workflows.json` store and its CRUD command surface,
  the complete workflow data model (typed `send-command`, `run-script`,
  `run-macro`, `wait`, and guarded `run-local-process` steps; `manual`,
  `on-connect`, and `hotkey` triggers), and a run engine that streams a
  workflow's steps into the active terminal through the same `send_input` seam
  macros use, with live progress and cancel. Only the `send-command` step
  executes so far; the sidebar/editor UI, the remaining step types, and trigger
  dispatch land in later updates. No user-facing UI yet.
