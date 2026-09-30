### Fixed

- Agent: session socket and log files left behind by long-dead sessions (whose
  saved state was also lost) are now cleaned up in the background when the agent
  starts. Only files of sessions whose daemon no longer answers are removed —
  running sessions, and sessions another desktop holds, are never touched
  (#2807).
