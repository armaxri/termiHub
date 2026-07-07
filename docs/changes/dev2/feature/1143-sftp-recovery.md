### Added

- The SFTP file browser now offers **Retry** and **Dismiss** controls when a
  connection fails, instead of leaving you stuck on the error message. Retry
  re-attempts the connection with the same settings; Dismiss clears the error
  (audit gap S1, #1143).

### Fixed

- When an SFTP session drops mid-browse (for example after a network blip, so
  the server reports "session not found"), the file browser no longer keeps
  looking connected with no way to recover. It now treats the session as gone,
  automatically attempts to reconnect, and shows the Retry control if it cannot
  (audit gap S2, #1143).
