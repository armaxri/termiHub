### Added

- The file editor now reflects external on-disk changes to open **remote**
  (SFTP, Docker, FTP, and agent-session) files, not just local ones. Remote
  transports cannot use OS file-watching, so the focused, visible editor tab
  re-`stat`s its open file on a short interval (paused while the app window is
  not focused) and, when the file's modification time or size changes
  out-of-band, reuses the same reload/conflict handling as local files: a clean
  buffer reloads silently, while a buffer with unsaved edits surfaces the
  "changed on disk" banner (Reload from disk / Keep my changes) without
  clobbering either side. Detection is a single lightweight metadata request and
  is confined to the open file, so it does not hammer remote connections (#1627,
  follow-up to #1620).
