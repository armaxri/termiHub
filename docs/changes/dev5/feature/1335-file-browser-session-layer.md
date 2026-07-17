### Fixed

- File browsing now works for FTP and Docker connections in the sidebar. Both
  connection types advertise the file-browser capability and implement the
  shared `FileBrowser` trait, but the sidebar routed every non-local capable
  type to the SSH-only `SftpManager` path, which tried to open an SFTP session
  from a config that has no SSH host — so the file browser stayed empty. These
  tabs now dispatch through the protocol-agnostic session layer
  (`session_*` commands on `SessionManager`), which routes file operations via
  the connection type's `file_browser()` and therefore works for any backend
  implementing the trait. SSH browsing is unchanged and keeps its existing
  `sftp_*` path (#1335, epic #1331).
