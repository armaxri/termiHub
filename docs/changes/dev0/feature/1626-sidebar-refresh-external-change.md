### Added

- The sidebar file browser now refreshes its listing automatically when the
  local directory it is showing changes on disk under another process. Adding,
  removing, renaming or modifying a file in the browsed directory updates the
  list without a manual Refresh — detection reuses the OS directory watcher
  (FSEvents / inotify / ReadDirectoryChangesW) with debouncing, re-targets as you
  navigate, and is torn down when the panel closes. The Refresh button remains as
  a manual backstop. Local browsing only; remote (SFTP / session) browsers are
  unaffected. (#1626)
