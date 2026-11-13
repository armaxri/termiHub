### Changed

- Workflows show readable names instead of internal ids: step kinds read "Send command",
  "Wait", … and triggers read "On connect", "On output match", … in the editor, the sidebar
  row and the run history. The sidebar row no longer shows the step-kind chain (#5529).
- The command palette lists saved workspaces by name with a "workspace" tag instead of
  "Launch workspace: <name>"; typing "launch workspace" still finds them (#5530).
