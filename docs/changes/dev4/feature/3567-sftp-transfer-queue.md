### Fixed

- SFTP uploads no longer hang forever when the connection drops mid-transfer. A
  stalled transfer is now retried automatically on a fresh channel and resumes
  where it left off, and Pause and Cancel respond even while the connection is
  wedged.
- Resuming an SFTP transfer can no longer corrupt the file. Before continuing,
  termiHub checks that the source is unchanged (size and modification time) and
  that the partial file holds only bytes it wrote; otherwise it restarts from the
  beginning and says so in the transfer queue. Previously a retry after a dropped
  connection could leave a gap of missing bytes in an upload, and a source
  modified while the transfer was paused was spliced onto the old partial.
