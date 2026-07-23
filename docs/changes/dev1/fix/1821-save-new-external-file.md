### Fixed

- Saving a connection to a **new or empty** external / shared-connection file no
  longer fails with "Failed to parse external file: …". The save path parsed the
  destination file before writing, so a not-yet-existing or empty target errored
  out before anything could be written. A missing or empty file is now treated as
  a fresh, empty store and written cleanly; a file that genuinely exists with
  malformed content still reports a clear parse error so it is never silently
  overwritten (#1821).
