# Changes

## Fixed

- The Transfer Queue panel now opens as soon as a transfer is registered, even
  when its `transfer-progress` events are dropped or delayed (e.g. under memory
  pressure). Each SFTP transfer seeds a `queued` row from the id its start
  command returns over the reliable request/response channel, so panel
  visibility no longer depends on the best-effort progress-event stream (#1632).
