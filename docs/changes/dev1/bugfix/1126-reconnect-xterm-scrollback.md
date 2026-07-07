### Fixed

- Clicking **Reconnect** on a disconnected terminal no longer wipes the
  scrollback when the reconnect fails. The terminal's scrollback is now
  snapshotted before the xterm instance is torn down and replayed into the
  fresh instance, so the "Scrollback is preserved below" promise on the
  disconnect / "Reconnect failed" overlay actually holds for direct
  connections (#1126).
