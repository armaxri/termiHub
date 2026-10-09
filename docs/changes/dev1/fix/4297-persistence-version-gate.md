### Fixed

- Data safety: macros, tunnels, external connection files and the connection
  file-scope state are now protected against downgrades. A file written by a
  newer termiHub is left unchanged and reported, never overwritten, and unknown
  fields written by a newer version are kept when this version saves (#4297).
- Data safety: when a settings or data file is corrupt, termiHub now keeps
  every backup (`<file>.bak`, `<file>.bak.1`, …) instead of overwriting an
  earlier one. If the backup cannot be written (for example on a full disk),
  the original file is left untouched, termiHub runs on whatever it could read,
  and it tells you so instead of replacing the only copy (#4297).
- Recovering a corrupt file written by an older termiHub now brings it up to
  date before dropping damaged entries, so valid entries are no longer
  discarded or left un-upgraded (#4297).
