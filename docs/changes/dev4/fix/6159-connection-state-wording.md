### Changed

- A connection's state now reads the same everywhere: the sidebar, tabs, the status bar, overlays
  and toasts say **Connecting…**, **Reconnecting…**, **Connection failed** or **Session ended**,
  and offer **Abort**, **Stop reconnecting**, **Retry** or **Reconnect** for it. "Connection
  lost" and "Disconnected" are gone: a dropped session says "Session ended" with what ended it
  on the line below, and an agent that went down reads "Connection failed" (#6159).
- After every reconnect attempt failed, a terminal says **Connection failed** with **Retry**
  (it said "Reconnect failed" with "Try again").
- A running reconnect is stopped with **Stop reconnecting** on terminal and remote-desktop tabs
  (it said "Cancel", "Stop" or "Abort").
- The app and the README use one name per thing: **tunnel**, not port forwarding, and
  **persistent session**, not background session. Settings search still finds the old names.
