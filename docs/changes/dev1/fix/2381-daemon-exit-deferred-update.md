### Fixed

- Agent: a staged self-update now auto-applies promptly when the **last
  daemon-backed (persistent) session exits on its own**, not only when it is
  explicitly closed or on the next reconciliation/self-update poll. #2378 wired
  this natural-exit hook for in-process sessions; daemon-backed sessions detect
  their exit inside the daemon client (`MSG_EXITED`/EOF), which previously had no
  way to reach back into the session manager. The daemon client now runs an
  installed exit hook on a natural exit, invoking the same shared
  `apply_deferred_update_if_idle()` helper — so a staged update lands the moment
  the agent goes idle regardless of how the last session ended (#2381).
