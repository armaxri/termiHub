### Fixed

- Restored the "Reconnecting…" feedback during a **transient agent-transport
  break** (#2555). When a remote agent's link briefly drops and the agent
  recovers its live sessions in place, each hosted terminal tab again shows the
  reconnecting overlay and a non-green tab-strip dot, instead of appearing
  frozen with no indication. The reconnecting state is now sourced from the
  shared session-lifecycle projection (a regression from the earlier read
  inversion, #2554); the fix folds it without starting a competing reconnect
  loop, so the agent's own in-place recovery is never double-driven.
