### Fixed

- Remote agent reconnect no longer stalls with the tab stuck "Reconnecting"
  after the SSH transport is restored. When a reconnect stands up a fresh agent
  whose startup recovers persisted sessions, a session daemon that had died
  leaving its socket file behind caused recovery to block for the full 30-second
  connect timeout — before the agent could answer the desktop's `initialize`
  handshake — so the reconnect appeared wedged. Session recovery now fast-fails a
  dead-but-lingering daemon socket and drops the session, so the agent comes back
  and a fresh session is created promptly (#2476).
