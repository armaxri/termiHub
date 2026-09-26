### Fixed

- Renaming or moving a saved connection (or a folder above it) while an editor is open no
  longer writes the old connection id back when that editor is saved. The workspace,
  workflow (on-connect triggers), schedule, tunnel, connection (jump-host hops) and
  shell-integration entry editors now follow the rename in their unsaved changes (#3603).
- The schedule and tunnel editors no longer discard unsaved edits when their list refreshes
  in the background (for example after a schedule run or a tunnel status change).
