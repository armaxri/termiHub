### Added

- **SFTP-only read-only fallback** in the file editor: a read-only remote file on
  a connection **without** an exec channel (SFTP-only / relayed), where no `sudo`
  elevation is possible, now offers a graceful fallback instead of a dead Save.
  The read-only banner explains that sudo elevation isn't available and provides
  two actions — **Save a copy…**, which writes the current buffer to a
  user-chosen writable path on the remote host, and **Download**, which saves the
  file to a local path via the standard download flow. The direct **Save** button
  stays disabled (a direct write would always fail), and no **Edit with sudo**
  action is shown for these connections. Each action gives feedback (a pending
  toast, then success or a recoverable error). The exec-capable "Edit with sudo"
  path (#1329) is unchanged. (#1330, epic #1323, concept #970)
