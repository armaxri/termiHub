### Added

- Workflow automation UI (epic #1851): a new **Workflows** sidebar and a
  **workflow editor** dialog, built on the shipped workflow foundation (#1852).
  The sidebar browses, searches, runs (against the active session, with a stop
  affordance driven by the live run state), edits, duplicates, exports/imports
  and deletes stored workflows, and can promote a macro into a new single-step
  workflow. The editor authors a workflow's name, description and tags, an
  ordered typed-step list (add via a typed "Add step…" menu, remove, reorder via
  a grip handle or up/down) with per-kind detail editors for `send-command`,
  `run-script`, `run-macro`, `wait` and `run-local-process`, and a Triggers
  section binding `manual` / `on-connect` (pick connections) / `hotkey`. Reached
  via a new Workflows activity-bar icon (behind the experimental-features flag
  while the rest of the epic lands). A shared `Textarea` UI primitive was added
  for multi-line step bodies. (Closes #1854)
