### Added

- Local files open in the built-in editor now reflect external on-disk changes.
  When another process rewrites a local file that is open in the editor and the
  editor buffer has no unsaved edits, the editor reloads the new content
  automatically (cursor and scroll position preserved). Detection uses OS file
  watching (FSEvents / inotify / ReadDirectoryChangesW) with debouncing, and the
  watcher is torn down when the tab closes. If the file changes on disk while the
  buffer has unsaved edits, the change is detected and a non-destructive notice is
  shown — your edits are kept and nothing is overwritten. Remote (SFTP / session)
  files are unaffected. (#1620)
