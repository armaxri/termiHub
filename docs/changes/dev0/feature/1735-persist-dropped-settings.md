### Fixed

- The **Line Height** appearance setting and the **confirm-before-closing-a-live-session**
  preference now survive a restart. Both fields existed on the frontend but were
  missing from the backend `AppSettings` struct, so they were silently dropped on
  the save→load round-trip. The most visible symptom: ticking "Don't ask again" in
  the live-session close dialog persisted `confirmCloseLiveSession: false`, but the
  backend threw it away, so the confirmation came back on the next launch. Both
  values are now stored and restored.
