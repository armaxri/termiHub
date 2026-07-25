### Changed

- Multi-window: a file transfer now appears **only in the window that owns its
  session**, from the start — no tab move required. Previously every window
  folded the app-wide `transfer-progress` broadcast, so a window that never owned
  a session still showed its transfers in the Open Connections "Transfers"
  section and the Transfer Queue panel. Folds are now scoped to the owning window
  via the backend `session → window` ownership map (#1900), and SFTP sidebar
  sessions now register their ownership so their transfers are scoped too.
  Single-window behavior is unchanged, and background/spawned transfers whose
  session no window renders still appear as before (#1964).
