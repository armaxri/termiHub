### Fixed

- Reattaching to a persistent session in a minimized or hidden window no longer
  stalls until the window is shown: the wait for usable terminal dimensions is
  now bounded by time rather than by animation frames, and it no longer resizes
  the terminal against a too-narrow transitional container (#4381).
- Closing or retrying an agent terminal during its automatic retry countdown,
  and cancelling a workflow that is running a local process or waiting for
  output, now takes effect immediately instead of after a polling interval
  (#4381).
