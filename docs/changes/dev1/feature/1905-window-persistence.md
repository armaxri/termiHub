# Changes

## Added

- **Window dimension in workspace and last-session persistence** (#1905, epic
  #1899). Saved workspaces and the auto-saved last session now record which
  native window owns each tab group, so a multi-window layout can survive a
  restart. The schema addition (`windowId` per tab group and a `windows[]` set)
  is optional and back-compatible: existing single-window saves are unchanged and
  load into the main window exactly as before.

## Notes

- Restore of a multi-window session is currently non-lossy but collapses into the
  main window; spawning and hydrating the secondary windows on restore is
  follow-up runtime work.
