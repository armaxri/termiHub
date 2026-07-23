### Added

- Importing a workflow now flags any `run-local-process` step it carries. Such a
  step runs a program on your local machine, so an imported one is **preserved
  but never auto-authorized**: a persistent toast surfaces how many local-process
  steps were imported and that they stay disabled until you review and authorize
  them. A clean import still reports just the count. This closes out the workflow
  import/export UI on the sidebar's export/import affordances (epic #1851, #1856).
