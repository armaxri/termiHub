### Fixed

- Agent self-update: an update binary that downloads and verifies but cannot be
  started (a corrupt or wrong-format executable) no longer kills the agent. The
  agent now restores its previous binary and keeps running, and the update stays
  staged for a retry. Previously the failed start was handed to `/bin/sh`, which
  exited and took the agent down with the broken binary left in place (#3064).
