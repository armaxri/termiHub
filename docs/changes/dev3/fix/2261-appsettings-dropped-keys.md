### Fixed

- Settings: several toggles no longer reset after an app restart. The backend
  `AppSettings` struct was missing fields for `confirmCloseAttachedTab`,
  `warnLargePortScan`, `warnLargePingSweep` and `screenReaderMode`, so
  `save_settings` silently dropped them at the IPC boundary and never wrote them
  to `settings.json`. Turning off a "Don't show again" / "Don't warn again"
  opt-out, or enabling screen-reader mode, now persists across restarts (#2261).
