### Fixed

- Agent: a staged self-update now auto-applies when the **last session exits on
  its own**, not only when it is explicitly closed. Previously the "reached zero
  active sessions → apply the pending update" hook fired solely from the explicit
  `close()` path, so an agent whose sessions all terminated naturally kept
  running the old binary until something else (an explicit close, or the next
  24 h self-update poll) happened to trigger the apply — delaying the update. The
  natural-exit path now runs the same idle-apply check, so the staged update
  lands the moment the agent goes idle regardless of how the last session ended
  (#2378).
