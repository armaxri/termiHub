### Fixed

- Transfer Queue: the reconcile backstop (#1645) no longer risks freezing a
  rich (FTP) transfer at `failed` while it is actually auto-retrying. The
  backend `transfer_list` snapshot now marks whether a transfer is _genuinely_
  settled, so a live handle that is momentarily `failed` mid retry — or awaiting
  a manual retry — is never folded into a terminal `failed` row; only real
  terminals (completed/cancelled, and genuinely-final legacy SFTP failures)
  settle a stuck row (#1657).
