### Added

- The file browser can now change file permissions (chmod). A "Change
  Permissions" action in a file/directory's context menu opens a small editor
  with an owner/group/other × read/write/execute checkbox grid kept in sync with
  an octal input, pre-filled from the entry's current mode; applying it updates
  the file and refreshes the listing (PROD-001). Supported for SFTP-backed (SSH)
  remote sessions and the local filesystem on Unix; byte-based backends
  (FTP, Docker) and non-Unix local paths do not offer the action.
