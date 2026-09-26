### Fixed

- A queued Docker file transfer that was paused or in flight when the app quit
  now resumes from its checkpoint after a restart instead of failing with
  "session unavailable". The transfer re-attaches to the same container by its
  id — through a reconnected session, or directly via the local container
  runtime — and the existing resume check still verifies the file before
  continuing. A container that was removed or recreated under the same name is
  never resumed into; a stopped container or unreachable runtime shows what to
  fix, and **Retry** works once it is back (#3585).
