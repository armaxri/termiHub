### Added

- HTTP monitors now keep their check history (#3462). Every check — status
  code, response time, pass/fail — is recorded for monitors running on this
  computer and on an agent, so a monitor's chart and **Recent Checks** survive
  stopping and resuming it and restarting the app. Each monitor row has a
  **Show checks** action, and **Export** writes the monitor's full history as
  CSV.
- The history is bounded (the newest 1,000 checks per monitor, for up to 7
  days, for up to 50 monitors) and stored only on this computer in
  `http-monitor-history.json`. It follows **Settings → Sessions → Network Tool
  History**: turning recording off stops it, and **Clear Network Tool
  History** also clears every monitor's checks. Removing a monitor drops its
  history.

### Changed

- Stopping the monitor shown in the HTTP Monitor panel keeps its chart and
  checks visible instead of clearing them.
