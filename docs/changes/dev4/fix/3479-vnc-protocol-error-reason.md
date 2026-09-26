### Fixed

- When a VNC server sends data termiHub can't handle (a malformed message, an
  unsupported encoding or pixel format, or image data that can't be decoded),
  the remote-desktop tab now shows why, for example "The VNC server sent data
  termiHub can't handle: unsupported encoding 7". Before, the reason only
  reached the log and the tab showed a generic "Connection lost". Such an error
  no longer triggers Auto-Reconnect, because reconnecting would meet the same
  server behaviour again; the Reconnect button still works. Ordinary network
  drops are retried as before (#3479).
