### Fixed

- Agent workers sharing a host no longer silently lose each other's persisted
  sessions. Multiple `--stdio` workers share a per-user `state.json`; without
  cross-process locking, two workers could each load, modify, and save the file,
  and the last writer would clobber the other's session (defeating the
  survive-restart guarantee). State writes now take an exclusive advisory file
  lock, re-read the current on-disk state, and apply only their own change before
  writing atomically, so concurrent inserts and removals are merged rather than
  overwritten (AGT-016).
- The agent no longer leaks zombie processes when a persistent-session daemon
  exits while its spawning worker is still running. Detached daemons are now
  reaped, so a long-running agent that cycles through many sessions does not
  accumulate defunct entries in its process table (AGT-018, #2580).

### Changed

- The agent now logs every remote-session ownership transition — a takeover
  evicting a live connection, a recovery connect being refused so the session
  stays with its owner, and clients connecting or disconnecting — so a
  "my session disappeared" situation can be explained from the logs instead of
  being invisible (OBS-012).
