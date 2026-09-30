### Fixed

- A persistent session that failed to start after it had already been stopped
  no longer leaves a broken entry behind. The error is now recorded on a
  complete session entry, so views that list a session's attached tabs cannot
  fail on it (#2979).

### Internal

- Raised unit-test branch coverage of the store slices (tab groups, workflow
  runs including `wait-for-output`, startup, window management, persistent
  sessions, UI chrome, macros) and ratcheted the vitest coverage thresholds.
