### Added

- The status-bar monitoring dropdown now shows a compact **CPU% sparkline** with
  a short rolling history of the active host's CPU usage (PROD-0030). History is
  reconstructed on the client from the live monitoring stream and kept to a
  fixed-size window (bounded memory), so it needs no backend change. The priming
  first sample (reported as 0% before a real delta exists) is shown as a gap
  rather than a misleading 0, and paused/stale monitors hold their last window
  instead of accruing points. Switching to a different monitored host resets the
  window.
