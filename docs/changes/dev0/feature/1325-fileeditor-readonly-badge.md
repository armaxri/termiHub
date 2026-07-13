### Added

- File editor now surfaces when a remote (SFTP) file is read-only: opening a
  file you have no write access to shows a **Read-only** lock badge next to the
  Remote badge (its tooltip shows the file's permission string) plus a
  dismissible info banner above the editor. Detection is driven by a
  non-destructive SFTP write-open probe, so it catches the owner-mismatch case
  the cheap permission hint cannot. This is detection only — direct save
  behaviour for writable files is unchanged; an elevated "save a copy" fallback
  lands in a later update (#1325, epic #1323).
