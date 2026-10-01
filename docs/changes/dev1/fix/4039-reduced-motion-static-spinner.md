### Changed

- With "reduce motion" enabled (macOS Reduce motion, Windows animation effects
  off), loading spinners no longer blink. They now show a still icon next to a
  steady status label such as "Connecting…", "Working…", "Reloading…" or
  "Updating…", and screen readers announce the in-progress state. This covers
  the SSH connecting and reconnecting overlays, the remote desktop overlay,
  pending buttons, tab and connection-path status, and the agent update badge.
  Indeterminate progress bars show a still striped bar. Nothing changes with
  full motion (#4039).
