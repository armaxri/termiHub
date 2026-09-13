### Fixed

- Downloading a file from the file browser now always confirms the outcome.
  Previously only the SFTP path showed feedback; a local "Save file as…" copy
  and a download from a Docker, FTP, or agent-hosted connection completed (or
  failed) with no toast at all. Every download path now shows a pending toast
  while it runs and resolves it into a success or a recoverable error
  (UX-017).

### Changed

- The transfer list inside the file browser now uses the same Cancel control as
  the docked Transfer Queue panel — matching icon, tooltip, and feedback —
  instead of a divergent button, so the two transfer surfaces speak one control
  language (UX-020).
