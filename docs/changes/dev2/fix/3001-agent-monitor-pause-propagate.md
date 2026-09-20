### Fixed

- Pausing system monitoring for an agent-hosted (remote) session now stops the
  agent's remote poller too, instead of only freezing the display on the
  desktop. Previously the agent kept sampling and streaming system stats while
  "paused", wasting remote CPU and bandwidth. Pause now unsubscribes the agent's
  monitoring poller and resume re-subscribes it (reusing the existing monitoring
  RPCs, so it works with older agents unchanged). The desktop still holds the
  badge at "Paused" and drops any in-flight sample, so the UI stays in sync
  (#3001).
