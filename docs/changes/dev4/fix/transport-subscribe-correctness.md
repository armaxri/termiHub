### Fixed

- Projection subscribe no longer risks a redundant resync (and a momentary
  version regression) when a diff frame reaches the client before the initial
  snapshot is adopted: such frames are now buffered and applied in order once
  the baseline is established, and a late/racing snapshot can never roll the
  cached version backwards (CONC-012).
- The remote-client WebSocket transport now supports multiple subscribers per
  projection region — a second subscription no longer silently displaces the
  first, unsubscribe removes only the calling subscriber, and the shared frame
  listener is detached once the last subscriber leaves (matching the desktop
  transport's semantics) (FEC-007).
