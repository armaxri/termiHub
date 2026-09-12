### Changed

- Saved HTTP monitors no longer auto-start a continuously-polling loop when the
  app launches. They are still listed (so they don't vanish and can be resumed)
  but load **stopped** and do no network work until you start/resume them — so a
  user with several saved monitors no longer pays a background HTTP request per
  monitor per interval from launch, forever, whether or not the monitors view is
  ever opened (PERF-008). Background monitoring is still available as an explicit,
  user-initiated start/resume.

### Fixed

- The HTTP monitor now skips its check entirely when nothing is subscribed to its
  results, rather than issuing an HTTP request every interval and broadcasting
  into a channel with no receivers (PERF-008).
- The HTTP monitor now polls on a fixed cadence and backs off on failure
  (SM-015). Previously it slept the interval _after_ each check, so the true poll
  period drifted by the request duration (skewing the Up/Down chart's time axis),
  and a failing endpoint was hammered at full rate. The schedule is now computed
  from fixed deadlines (no drift by check latency) and a consecutively-failing
  host is probed at a geometrically increasing, capped interval that resets to the
  configured interval on the first success.
