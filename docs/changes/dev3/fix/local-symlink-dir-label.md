### Fixed

- Symbolic links that point at a directory are now navigable in the local file
  browser. The listing previously read a symlink's own (non-following) metadata
  for the directory flag, so a symlink-to-directory was marked as a symlink but
  not as a directory and could not be opened; a single-path stat, conversely,
  followed the link but errored outright on a dangling (broken) link. Both paths
  now share one rule: the link is detected without following (so it is still
  flagged as a symlink and its target is recorded), then the target is followed
  to decide whether it behaves as a directory. A dangling or looping link is
  handled gracefully — it is reported as a non-directory symlink and never
  aborts the rest of the directory listing (CORE-037).
