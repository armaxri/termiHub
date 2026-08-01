### Fixed

- A connection's chosen icon no longer disappears after saving. The frontend
  `SavedConnection.icon` field had no matching backend field, so the icon was
  silently dropped when a connection was saved and lost on the next app restart.
  The backend now models `icon` on both the in-memory `SavedConnection` and the
  on-disk connection tree node, persisting the user's icon choice across
  restarts (Closes #2316).
