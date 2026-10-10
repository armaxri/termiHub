### Security

- Embedded HTTP server: one client IP can no longer occupy every connection slot. Each client
  IP may hold at most a quarter of the server's concurrent-connection cap (at least 2), the same
  limit the FTP server enforces; further connections from that IP get `503` and are recorded in
  the access log (#4686).
