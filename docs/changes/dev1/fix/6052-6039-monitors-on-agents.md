### Fixed

- HTTP monitors: a monitor set to run on an agent is checked from that agent after a restart, or not
  at all with the reason on its row, instead of from this computer. Where it runs is stored with it,
  and a restore of an older backup keeps it (#6039).
- HTTP monitors: a monitor on an agent whose agent is gone reads "Not reachable" instead of running;
  a start the agent did not answer may still check there; a stop the agent did not get reads
  "Stopping" and is sent when it is back, also after a restart (#6052).
- HTTP monitors: starting, stopping, pausing and resuming a monitor no longer holds up the window
  while its agent answers (#6052).
- HTTP monitors read like Services rows: each says where it runs, its state in words, and why it
  does not check with a next step ("Connect agent", "Set it up again"); the panel's actions are
  labelled and offer only what can be done now; the HTTP monitor tab no longer shows a disabled
  "Run on", and the URL is flagged only once it was typed and left.
- HTTP monitors: every row says where it runs ("This computer", the agent's name cut at its end, or
  "Location unknown") and its state in one word; a monitor whose agent is gone reads "Agent offline"
  with a grey dot instead of "Not reachable", a failing one "Down" with its last check, and a running
  one shows its last check ("last check HTTP 200, 12s ago").
- HTTP monitors: "Set it up again" opens a repair screen titled "Set up <name> again" that asks where
  it runs, and "Save and start" replaces the broken monitor; Cancel leaves it as it was.
