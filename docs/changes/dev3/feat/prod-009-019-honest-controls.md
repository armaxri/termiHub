### Changed

- The Transfer Queue no longer shows Pause, Resume, or Retry controls for SFTP
  transfers, which can't actually be paused, resumed, or retried — only FTP
  transfers support those operations. Previously those buttons appeared but did
  nothing for SFTP transfers. Cancel remains available for every transfer
  (PROD-009).
- The RDP connection's "Redirect Audio Output" toggle is now disabled on Linux
  with a note explaining that audio output redirection (rdpsnd) isn't
  implemented on the Linux build yet, instead of offering a toggle that has no
  effect. It stays fully functional on macOS and Windows (PROD-019).
