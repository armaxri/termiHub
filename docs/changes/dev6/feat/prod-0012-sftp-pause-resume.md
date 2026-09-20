# Changes

## Added

- **Pause / resume for SFTP transfers (PROD-0012).** SFTP uploads and downloads
  now support pause, resume, cancel, and auto-retry from the Transfer Queue —
  the same rich queue behaviour FTP already had. A paused or retried transfer
  resumes from the byte offset already at the destination rather than starting
  over: the destination size is re-verified before appending, and on any
  mismatch (or a server that refuses the seek/append) the transfer transparently
  restarts from the beginning and reports which path it took. Pause releases the
  session's concurrency slot so a queued transfer can run in the meantime, and
  cancel removes the partial file. Non-streaming byte-based transfers
  (Docker/FTP-listing/agent copies) still cannot pause and report so honestly.

## Changed

- SFTP transfers now run on the shared transfer-queue model, so
  `Pause`/`Resume`/`Retry` in the Transfer Queue act on them instead of being
  no-ops.
