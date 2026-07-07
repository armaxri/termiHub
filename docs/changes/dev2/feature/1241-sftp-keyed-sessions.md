### Fixed

- Closing a tab that had an open SFTP file browser now closes its underlying
  SFTP (and SSH) session instead of leaking it. Previously the backend session
  stayed connected until the app quit (the L1 leak, #1241).

### Changed

- The **Open Connections** panel now lists SFTP sessions individually — one
  killable row per live backend session — instead of a single combined row.
  Each row has its own Kill, and the section has a Kill All. Sessions whose
  owning tab has gone away are still shown with an "orphaned" warning badge so
  they can never become invisible or unkillable (#1241).
