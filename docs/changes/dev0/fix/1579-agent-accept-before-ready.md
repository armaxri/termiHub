### Fixed

- Agent: a listening agent no longer logs `Listening on …` and accepts TCP
  connections before it can answer them. The listener previously bound the
  socket (and logged readiness) up front, then did its expensive startup work
  (`SessionManager` init including the #1551 binary byte-compare, default-shell
  seeding, session recovery) before reaching its accept loop. Because the kernel
  accepts connections into the listen backlog the moment the socket is bound, a
  desktop that connected during startup got an accepted-but-unread socket and
  its `initialize` stalled with no response. The bind now happens only after
  startup finishes, so the readiness log is truthful and an early client is
  cleanly refused (the desktop retries with backoff) rather than
  accepted-then-stalled (#1579).
