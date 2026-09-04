### Fixed

- Loading spinners across the app no longer freeze for users with "reduce
  motion" enabled. The global reduced-motion backstop collapsed every animation
  to a single frame, leaving each spinner static (reading as a hung/broken
  state). Every in-progress spinner — button pending state, indeterminate
  progress bars, loading toasts, the connecting/reconnecting overlays, the file
  editor, file browsers, agent setup, connection-path checks, status-bar
  monitoring, workspace launches, workflow runs, and the agent-update badge —
  now keeps signalling progress: it spins normally, and under reduced motion it
  degrades to a gentle opacity pulse instead of freezing (#2603).
