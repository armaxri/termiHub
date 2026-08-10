### Fixed

- **Remote Agents sidebar & terminal tabs no longer show a stale "connected"
  green indicator after a drop.** A terminal tab whose live agent session was
  lost on reconnect (the transport came back but the session could not be
  recovered) kept a green connection dot as if healthy; its status dot now
  reflects the disconnected/lost state (#2524, #2512).
- **The remote-agent header no longer hides the agent name.** The state bubble,
  agent name and version badge now sit on the first row and the action buttons
  drop to a second row, so a connected agent's action buttons can no longer
  crowd the name off the row (#2524).
