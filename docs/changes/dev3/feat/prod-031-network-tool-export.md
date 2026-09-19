### Added

- The Network Tools panels can now export their results to a file. Ping,
  Traceroute, Port Scanner, and DNS Lookup each gained an **Export** button that
  writes the results as CSV via a standard save dialog (the same file-write
  plumbing used elsewhere in the app). The button is disabled until there are
  results to export, and a toast confirms success (or a recoverable error on a
  failed write) (PROD-031).
