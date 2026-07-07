### Fixed

- Rapid SFTP folder navigation no longer desyncs the path from the shown files.
  `navigateSftp`/`refreshSftp` awaited the directory listing with no ordering
  guard, so when two navigations overlapped, whichever list resolved last won —
  leaving the current path and the displayed file list out of sync. A monotonic
  request sequencer now drops superseded (stale) list responses, so only the
  latest navigation updates the view (audit gap R1, #1143).
