### Fixed

- Workspace: importing a workspace whose tab references a connection that no
  longer exists no longer silently keeps the broken reference. The tab and its
  reference are still preserved (nothing is deleted), but a warning now names the
  workspace and the missing connection so you know the workspace is partially
  broken (PER-009).
