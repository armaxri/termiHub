### Fixed

- Open Connections panel: kill, disconnect, cancel and stop actions no longer
  fail silently. Previously a failed teardown was swallowed while the row was
  removed optimistically, so the user could believe a still-live connection was
  gone. Now a failed action surfaces an error toast, logs to the LogViewer, and
  keeps the row (for a bulk "Kill All", only the sessions that actually stopped
  are removed — the failed ones stay listed and killable). Covers local /
  spawned / proxy / agent sessions, connecting-tab cancels, establishing-agent
  cancels, and the X server stop (UX-033, FEC-009).
- Failed removal of a stale stored credential (during an agent auth-failure
  retry) and a failed transport disconnect while deleting an agent are now
  logged to the LogViewer instead of being silently dropped (WA-FE-005).
