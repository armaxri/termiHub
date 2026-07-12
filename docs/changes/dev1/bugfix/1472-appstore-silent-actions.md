### Fixed

- Store-level mutating actions that previously failed silently now surface a
  recoverable error toast, so a failed persist no longer leaves the UI quietly
  out of sync with disk. Newly covered actions: connection bulk delete,
  new/delete folder, folder expand/collapse persistence, duplicate,
  move-to-file, move-to-folder and bulk move; remote-agent persist
  (new/update/reorder/delete), disconnect, session refresh, and connection
  definition save/update/delete plus folder delete; workspace duplicate; and
  save/clear of the restored last session (#1472).
