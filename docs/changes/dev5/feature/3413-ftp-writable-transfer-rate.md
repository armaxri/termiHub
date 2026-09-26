### Added

- Tunnels now show a live, smoothed upload/download rate (e.g. `↑ 12 MB · 340 KB/s`)
  next to their running byte totals while connected.
- The Transfer Queue footer shows the combined rate of the active transfers and an
  estimated time until the queue is done. The estimate is hidden while every transfer
  is paused or when a pending file's size is unknown.
- FTP editor tabs carry an **FTP** badge explaining the protocol's editing limits
  (whole-file re-upload, no atomic save, no sudo save), and show a note when the server
  does not report whether the file is writable. These limits are documented in the
  quickstart guide.

### Fixed

- The per-transfer time-remaining estimate in the Transfer Queue now actually appears,
  and the fallback transfer rate no longer jumps on bursty progress updates; the
  estimate restarts after a pause, resume, or retry.
- FTP files the server reports as read-only for your login (MLSD `perm` fact or `LIST`
  permission bits) now open read-only with Save disabled, instead of failing only when
  saving. Listings without permission facts no longer claim every file is writable.
