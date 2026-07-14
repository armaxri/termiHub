### Added

- **FTP file transfers** — upload and download files over FTP/FTPS with live
  progress, speed, and ETA. Transfers run on their own data connection, so
  browsing the server stays responsive while a transfer is in flight
  (#1336, epic #1331).
- **Shared transfer-queue model** backing transfers: per-connection concurrency
  limit (2 at a time by default; the rest queue and start automatically as
  slots free), **pause/resume**, **cancel**, and **automatic retry** on failure
  (up to 3 attempts with exponential backoff). Interrupted transfers resume from
  where they stopped via FTP `REST`, rather than restarting from zero. Exposed
  through generic `transfer_pause`/`transfer_resume`/`transfer_cancel`/
  `transfer_retry`/`transfer_list` commands so SFTP can adopt the same model
  later (#1336).

### Changed

- The `transfer-progress` event now also carries the richer queue `state`,
  transfer `speed`, `totalBytes`, ETA, and retry-attempt fields. Existing
  fields are unchanged, so current SFTP transfer progress and toasts are
  unaffected (#1336).

_Backend support only — the dedicated transfers panel UI lands in a follow-up
(SI-6)._
