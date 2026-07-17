### Added

- File editor support for session-layer file browsing: files opened from an FTP,
  Docker, or agent-session file browser now open in the editor and can be saved
  back over the session layer. Previously the Edit action (and double-click /
  Enter on a file row) silently did nothing for these connection types, because
  the editor tab could only reference an SSH `SftpManager` session. An editor tab
  can now reference a session-layer browser instead, reading and writing through
  `session_read_file` / `session_write_file`, and a session-backed editor tab no
  longer puts the file browser into SFTP mode. The SFTP-specific affordances
  (read-only detection, sudo/elevated writes, "save a copy", download) remain
  exclusive to SSH, which the session layer does not expose. SFTP editing is
  unchanged (#1557).
