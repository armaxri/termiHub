### Added

- Remote system monitoring now offers a **Retry** control in the status bar
  whenever an auto-connect attempt fails, so a failed monitoring connection is
  no longer a dead-end. Retry clears the failed-host latch and re-attempts the
  connection (audit gap G7, #1148).
- Cancelling the SSH password prompt during monitoring auto-connect now shows a
  subtle "Monitoring not connected" affordance in the status bar (with a
  reachable Retry) instead of silently doing nothing (audit gap G8, #1148).

### Fixed

- A stale monitoring error tooltip no longer lingers in the status bar when
  switching between hosts; the error is cleared as soon as a fresh connection is
  attempted or a successful stat update arrives (audit gap G9, #1148).
