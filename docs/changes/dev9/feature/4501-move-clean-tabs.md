### Changed

- **Move tabs** on window close now moves every tab the other window can reopen, not only
  live sessions and unsaved editors: saved file editors, Settings, the log viewer, network
  diagnostics, plugin details and connection, tunnel and workspace editors without unsaved
  changes reappear in the destination window. A transfer view still closes with its window.
  The close dialog names which tabs move and which close. If the destination window already
  shows Settings, the log viewer or the same saved file, that tab is brought to the front
  instead of opening a duplicate (#4501).
