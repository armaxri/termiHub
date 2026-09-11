### Fixed

- Agent-hosted terminal tabs can no longer get stuck showing "Reconnecting…"
  forever. When an agent's SSH transport recovered but the follow-up
  `connection.list` never answered, the hosted tabs were left in a transient
  reconnecting state with no timer and nothing else driving them, so they sat on
  the reconnect spinner indefinitely (only a manual Stop escaped). termiHub now
  bounds the post-reconnect session-list probe (a small, per-attempt-timed retry
  so a hung agent can no longer strand the connection) and, when the sessions
  still cannot be confirmed, settles each tab to an explicit "session lost"
  state with a manual restart action instead of a silent perpetual spinner
  (SM-001).
