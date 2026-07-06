### Changed

- Downloads that termiHub performs in the background (remote agent binaries and,
  on Windows, the bundled X server) now stream to disk with real, incremental
  progress instead of jumping from 0% to 100% only once the whole file has been
  fetched — progress reflects bytes actually received. The full artifact is no
  longer held in memory while downloading (#1103).

### Fixed

- A download from a server that connects but then stalls (sends no further
  bytes) now fails after a bounded timeout instead of hanging indefinitely. The
  destination file is never left holding a partial download: the body is written
  to a temporary file and atomically moved into place only once complete (#1103).
