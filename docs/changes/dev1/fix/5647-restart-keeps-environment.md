### Fixed

- Backup: "Restore and restart" now relaunches termiHub directly with the same environment
  and arguments on every platform. On macOS the restart went through LaunchServices, which
  dropped settings such as a custom profile directory (`TERMIHUB_CONFIG_DIR`), so the app
  could come back on the default profile. A restart that cannot be started is now reported
  in the restore dialog instead of the app simply closing.
