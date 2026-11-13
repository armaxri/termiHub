### Fixed

- Sidebar: remote agent names are shown exactly as entered instead of in all caps.
- Sidebar: a remote agent that has never connected shows a neutral grey dot ("Not connected")
  and a "Connect" action. The red dot and "Reconnect" now appear only after a failed connect,
  an unexpected drop or a stored connection error (#5621).
- Sidebar: the Connections empty state no longer shows a stray "." on its own line under the
  experimental-features link.
