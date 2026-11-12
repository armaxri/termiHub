### Changed

- UI: connection type names and other names the backend provides follow the copy style guide
  (`docs/copy-style.md`). The connection type picker now says "Local shell" and "Serial
  port", like the rest of the app. Network tools read "Port scan", "Ping sweep", "DNS
  lookup" and "Open ports", the HTTP monitor service is "HTTP monitor", and the embedded
  servers are "HTTP server", "FTP server" and "TFTP server". Only the shown text changed;
  type IDs and saved connections are unaffected.
