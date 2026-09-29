### Fixed

- Agent sessions: a session daemon no longer freezes when the agent process
  attached to it stops reading while the shell is printing. The daemon now
  drops such a connection after 30 s without progress and keeps the session
  running, with its output kept for replay when the agent reattaches. A slow
  connection that keeps reading is never dropped and loses no output (#3890).
