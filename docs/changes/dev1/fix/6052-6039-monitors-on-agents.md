### Fixed

- HTTP monitors: a monitor set to run on an agent is checked from that agent after a restart, or not
  at all with the reason on its row, instead of from this computer. Where it runs is stored with it,
  and a restore of an older backup keeps it (#6039).
- HTTP monitors: a monitor on an agent whose agent is gone reads "Not reachable" instead of running;
  a start the agent did not answer may still check there; a stop the agent did not get reads
  "Stopping" and is sent when it is back, also after a restart (#6052).
- HTTP monitors: starting, stopping, pausing and resuming a monitor no longer holds up the window
  while its agent answers (#6052).
