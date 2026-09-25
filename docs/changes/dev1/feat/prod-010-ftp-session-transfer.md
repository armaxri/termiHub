### Changed

- FTP file-browser downloads and uploads now run through the rich **Transfer
  Queue** engine, exactly like SFTP: each transfer shows up as a tracked queue
  row with live progress and ETA, and can be paused, resumed, retried, and
  cancelled. Previously FTP transfers were a silent blocking round-trip with no
  queue entry and no progress. The FTP connection settings are resolved
  server-side from the live session, so credentials never round-trip through the
  UI. Docker and remote-agent sessions (which cannot drive the queue) keep the
  existing byte-based read/write fallback (PROD-010).
