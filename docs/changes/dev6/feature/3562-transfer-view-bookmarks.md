### Added

- Dual-pane transfer view: both panes have the file browser's **Bookmarks** menu. The local pane
  uses the local bookmarks and the remote pane uses the remote connection's bookmarks — the same
  lists the sidebar file browser shows. (#3562)

### Changed

- Deleting a saved connection now also deletes its file browser bookmarks, and deleting a saved
  remote agent deletes the bookmarks of its sessions. Local bookmarks and bookmarks of unsaved
  connections are kept. (#3562)
