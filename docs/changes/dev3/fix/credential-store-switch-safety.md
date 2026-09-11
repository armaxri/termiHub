### Fixed

- Switching the credential storage mode no longer risks silently losing your
  saved credentials. Previously, if the current store could not be read at the
  moment of the switch (a locked master-password store, a decrypt error, or an
  I/O error), the migration collected zero credentials and the switch still
  "succeeded" reporting `0` migrated — the credentials were still on disk in the
  old store, but the active mode had moved on and they appeared lost. The switch
  now **aborts with a clear, actionable error** when the source store cannot be
  read in full, leaving the source untouched so you can unlock or repair it and
  retry. A genuinely empty store (0 credentials) is still a legitimate switch,
  and the migrated count plus any per-credential migration warnings are surfaced
  rather than swallowed (TAURI-011).
