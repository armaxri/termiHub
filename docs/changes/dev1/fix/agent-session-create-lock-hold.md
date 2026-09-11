### Fixed

- Opening a new session on an agent no longer freezes input, resize, listing,
  and teardown for the agent's other live sessions while the new session's
  connection is being established. The agent previously held its single
  session-wide lock for the entire duration of a session's daemon spawn and
  connect (or in-process SSH handshake, up to ~30s), so one slow or unreachable
  host being opened stalled every other healthy session on that agent. The
  expensive connect now runs without holding that lock (CONC-004).
