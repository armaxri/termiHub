### Fixed

- Keystrokes typed into an agent-hosted terminal while its connection is
  reconnecting are no longer replayed into the recovered remote session once the
  link comes back. Input during an outage is now dropped at the source (the tab
  already shows a reconnecting overlay), so stale commands can never be injected
  into a shell the user saw as disconnected, and the input queue can no longer
  grow without bound during a long outage. The latest terminal resize is still
  applied so the recovered session keeps the correct dimensions (CONC-014).
- A remote agent's I/O task can now always be force-stopped on
  disconnect/cleanup. Previously a task wedged in a blocking reconnect could
  never observe the cooperative shutdown signal, leaking its SSH session; a
  retained abort handle now guarantees teardown (CONC-009).
- The desktop now reports its real application version to remote agents during
  the connection handshake instead of a hardcoded `0.1.0`. The agent echoes this
  to other connected clients (used by the connected-client update guard), so the
  reported version is now accurate rather than a constant (AGT-014).
