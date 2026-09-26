### Fixed

- Re-attaching a persistent agent session this desktop had detached from no longer silently takes
  it away from another desktop that opened it in the meantime. The attach is refused instead and
  the other desktop keeps the session; taking a session over always requires an explicit
  **Reclaim** or a confirmed **Take over**.
