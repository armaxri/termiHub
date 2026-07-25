### Added

- Broadcast input visual indicators: while broadcast mode is active, every
  participating panel now shows an amber ring (the source terminal additionally
  gets an inner glow), each participating tab shows a `Radio` badge next to its
  title (visible even when the tab is inactive), and a new status-bar pill shows
  the live target count (`Broadcast (N terminals)`) and stops broadcast on
  click. When every target is disconnected the pill becomes a warning
  (`Broadcast (0/N connected)`) to signal that typed input is being dropped
  until a target reconnects (#1957, epic #1954).
