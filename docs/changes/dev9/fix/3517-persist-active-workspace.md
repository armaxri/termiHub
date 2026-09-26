### Fixed

- Workspaces: the active workspace is now remembered across restarts. When the
  last session is restored, the workspace that was active is re-activated, so
  its theme / font overrides and its default directory / environment for new
  local shells apply again — with "always restore", before the window first
  renders, so there is no flash of the global theme. A workspace deleted in the
  meantime is skipped. Deleting or renaming the active workspace now also
  updates its name in the UI (#3517).
