### Fixed

- Remote agents: an agent's "update available" notice no longer wraps one word per line
  inside the narrow sidebar row and gets cut off. The row shows a small marker; the notice is
  a strip under the row with "Update to v<x> available", a short note and a "Restart agent and
  update" button. With sessions open on the agent, the button first says how many there are
  and that they keep running: the agent updates once the last one closes (#5821).
