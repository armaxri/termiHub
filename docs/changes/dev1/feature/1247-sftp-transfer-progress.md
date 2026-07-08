### Added

- SFTP transfers now render live progress across the app (issue #1247, stage
  S2/D3). Each in-flight download or upload appears as a row in the Open
  Connections **Transfers** section with an inline progress bar, live
  percentage / byte counts, and a **Cancel** button (plus **Cancel All**); as a
  compact footer in the file browser for the active session; and as a
  status-bar aggregate showing `N transfers · P%`. Cancelling fires
  `sftp_cancel_transfer`, and killing an SFTP session first cancels that
  session's in-flight transfers before closing it, so a transfer can never keep
  a dead session's channel alive. Indeterminate transfers (unknown size) show
  an animated bar instead of a percentage. Built on the `transfer-progress`
  event and cancel command from #1245.
