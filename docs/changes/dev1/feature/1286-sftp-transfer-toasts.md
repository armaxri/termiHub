### Added

- Completed SFTP transfers now confirm with a toast (issue #1286, stage D2,
  follow-up to #1247). When a transfer finishes it shows a single success toast
  (`Downloaded <file>` / `Uploaded <file>`); when it fails it shows a single
  recoverable error toast carrying the backend's failure message
  (`Download/Upload of <file> failed: <reason>`). The toasts are driven off the
  terminal `transfer-progress` phase, so background transfers that never went
  through the file-browser's own feedback path are now surfaced too.

### Changed

- Cancelling an SFTP transfer raises no toast from the terminal transfer phase —
  the Cancel button already shows its own "Transfer cancelled" confirmation and
  the user initiated the cancel, so a second toast off the `cancelled` phase
  would be redundant. This is a deliberate choice for the `cancelled` transfer
  phase (it also prevents a duplicate cancel toast).
- The file browser's per-transfer success/error toast is now owned exclusively
  by the `transfer-progress` event path, so a single transfer produces exactly
  one terminal toast (no duplicate between the file-browser feedback and the new
  event-driven toast). The file browser keeps its pending "Downloading…/
  Uploading…" toast and dismisses it on completion.
