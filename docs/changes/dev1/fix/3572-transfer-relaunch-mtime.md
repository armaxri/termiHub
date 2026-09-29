### Fixed

- A file transfer resumed after restarting the app no longer continues from its old offset when
  the source file was rewritten to the same size while the app was closed. The source modification
  time is now saved with the transfer's checkpoint, and a changed file restarts from the beginning
  instead of producing a corrupted copy (#3572).
