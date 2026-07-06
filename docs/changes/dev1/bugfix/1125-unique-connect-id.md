### Fixed

- Rapidly cancelling and retrying (or a reconnect firing while the previous
  connect was still slow) no longer aborts the fresh connection attempt and
  lands the tab in a confusing Failed state. Each connect attempt now uses a
  unique per-attempt id, so a stale attempt's cancellation can only cancel
  itself and never the newer, in-flight attempt for the same tab (#1125).
