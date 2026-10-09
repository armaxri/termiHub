### Fixed

- Disconnecting or shutting down a remote agent no longer sends its open tabs
  into minutes of "Reconnecting…" that could never succeed and then ended in a
  confusing failure. The tabs now stop right away and show "Agent disconnected"
  with a Reconnect button, which brings the agent back and starts a new session.
  If the agent's connection drops on its own, tabs still reconnect automatically
  as before, and a tab you stopped yourself is never reconnected behind your back.
