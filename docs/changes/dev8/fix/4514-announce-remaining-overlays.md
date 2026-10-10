### Fixed

- Screen readers now announce the remaining connection-state screens: the
  "Taken over by another desktop/window" overlay and the files-only "no shell"
  panel (politely), and the plugin crash overlay, the agent error tab (including
  a failed manual reconnect) and the remote-desktop failure screens
  (assertively, with the error text; an intentional server logoff is polite).
  Each is announced once and described by its message, and in the active tab
  focus moves to its primary action (Reclaim, Restart session, Reconnect, Open
  Files). After a successful Reclaim, focus returns to the terminal (#4514).
