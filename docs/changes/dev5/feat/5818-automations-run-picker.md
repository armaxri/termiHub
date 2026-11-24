### Changed

- One run picker now starts a macro or a workflow on one or more terminals (#5818). It
  replaces the terminal's Play macro dialog and the workflows' Run on dialog. Choose this
  terminal, the broadcast set, this panel, all terminals, a saved group, or pick terminals
  from a list that shows which ones are live. The picker opens on your last choice, and a
  run on more than one terminal still asks you to confirm the list of terminals first.
  Macro rows have a new Run on button that opens it.
- The picker no longer asks for a typing speed: a macro types at the speed saved with it.
- A macro played on several terminals now runs on each one on its own, up to 8 at a time
  (or one after another with Run in parallel turned off under More), like a workflow. It
  no longer types into all of them in lock-step: a slow terminal no longer holds the
  others back, and a terminal that disconnects stops only its own run.
- Every tab a macro or a workflow is typing into shows one "Running automation" badge with
  its progress on that tab. It replaces the badge that only multi-terminal macro playback
  had, and now also shows for a single terminal and for workflow runs. Click the badge, or
  use Stop automation in the tab's menu, to stop the run on that tab only.
