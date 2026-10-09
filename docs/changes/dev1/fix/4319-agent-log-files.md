### Fixed

- Remote agent: each agent process (the connection worker, every persistent-session daemon and
  the registry) now writes its own log file, `termihub-agent-<role>-<pid>.log`, instead of all of
  them sharing one file. Log rotation in one process can no longer lose the lines of the others.
  All agent log files together are capped at about 20 MB on the remote host (#4319).
- Remote agent: a persistent-session daemon's error output no longer duplicates its log, is capped
  at 1 MB, and is kept in the agent's log folder instead of being deleted when the session ends
  (#4319).
