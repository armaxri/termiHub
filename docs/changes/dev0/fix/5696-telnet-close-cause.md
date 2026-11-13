### Changed

- Terminal: when a Telnet or SSH server closes the connection cleanly, the
  scrollback now reads "— connection closed by server hh:mm:ss —" instead of
  "— connection lost hh:mm:ss —". A broken link (reset, failed write, keepalive
  timeout) still reads "connection lost". The backend now reports why a session
  ended on the `terminal-exit` event (#5696).
