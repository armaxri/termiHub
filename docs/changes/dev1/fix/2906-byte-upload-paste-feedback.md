### Fixed

- File uploads and pastes to byte-based file browsers (Docker, FTP, and
  remote-agent connections) no longer complete silently. These backends have no
  dedicated streaming transfer channel, so an upload or paste is a blocking
  read/write round-trip that emits no transfer-progress event — previously it
  finished with no toast at all, leaving no way to tell whether it worked. Such
  uploads and pastes now show a pending toast that resolves to a success or a
  recoverable error toast, matching the feedback the SFTP transfer path already
  gives. The SFTP-backed path is unchanged and is not double-toasted (#2906).
