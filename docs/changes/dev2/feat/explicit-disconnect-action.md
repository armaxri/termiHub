### Added

- Added an explicit **Disconnect** action to the tab context menu (UX-015). It drops a
  session's live backend connection while keeping the tab open in a reconnectable state
  (scrollback preserved, Reconnect offered) — previously the only way to end a live
  connection was to close the tab, which was destructive.
