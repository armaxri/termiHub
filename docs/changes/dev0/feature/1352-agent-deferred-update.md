### Added

- Deferred agent updates: a remote agent can now be told to update without
  interrupting active sessions. The update is recorded and applied strictly when
  the agent's last session disconnects, leaning on the detached-daemon model so
  persistent sessions survive the binary swap; the next connection reports the
  new version. When a connected agent reports a staged update
  (`agent.update_available`), a banner appears near the agent's header in the
  sidebar. "Apply Now" forces the update — an idle agent swaps immediately and
  reconnects, while a busy agent defers the swap until its last active session
  disconnects (the banner reports how many sessions it will wait on). A dropped
  connection right after an immediate apply is treated as the expected binary
  swap, not a failure. "Dismiss" hides the banner for the session (#1352).
