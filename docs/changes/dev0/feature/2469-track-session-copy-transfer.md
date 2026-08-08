### Fixed

- Copying a file between two SSH SFTP file-browser panes (session→session
  copy/paste) now appears in the Transfer Queue. The paste is tracked as two
  rows — a download of the source and an upload to the destination — each
  carrying the remote path and the user-facing file name, instead of moving the
  bytes silently with no queue entry (#2469).
