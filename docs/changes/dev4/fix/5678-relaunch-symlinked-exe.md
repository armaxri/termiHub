### Fixed

- Backup: "Restore and restart" now works on macOS when termiHub was started from a path
  that contains a symlink. The relaunch resolves the real executable instead of refusing
  the symlinked path, and keeps the instance's environment and arguments.
