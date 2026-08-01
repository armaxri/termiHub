### Fixed

- Agent: a session whose backend process exited on its own (a daemon-backed
  session that received `MSG_EXITED`/EOF, or an in-process connection whose
  output channel closed) stayed reported as `running` until it was explicitly
  closed. The `SessionStatus::Exited` state was never set in production, so the
  Open Connections panel and the agent node in the sidebar showed already-dead
  sessions as `running`, and such sessions lingered as "active" in the agent's
  session map (a resource-leak/cleanup correctness issue). The agent now settles
  a session to `exited` when its backend liveness signal fires, so dead sessions
  are reported as `exited` (and no longer counted as active) while remaining
  visible for explicit cleanup (#2369).
