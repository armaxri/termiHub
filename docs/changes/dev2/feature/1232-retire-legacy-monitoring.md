### Changed

- Remote system monitoring now runs on a single push-based path. Desktop-direct
  SSH tabs monitor through their terminal session's `MonitoringProvider` (the
  same channel remote-session/agent tabs already use) instead of the legacy
  pull-based path that opened a second SSH connection and polled it every 5 s.
  Each monitor is keyed by the owning terminal session, so switching tabs no
  longer tears down another host's monitoring. Because monitoring now reuses the
  already-authenticated terminal session, it no longer prompts separately for a
  password (#1232, part of #1193).

### Removed

- The status-bar monitoring "Monitor" connection picker (which let you monitor
  an arbitrary saved connection by opening a standalone SSH session) and its
  manual "Refresh" action have been removed: monitoring is tied to the active
  tab's live session and updates continuously via push. The legacy
  `monitoring_open` / `monitoring_fetch_stats` / `monitoring_close` backend
  commands were removed with it (#1232).
