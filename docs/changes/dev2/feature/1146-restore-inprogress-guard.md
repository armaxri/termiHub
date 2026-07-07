### Fixed

- A workspace restore or launch can no longer overwrite the previously-good
  saved session with a mid-restore snapshot. While a restore/launch is settling,
  a manual tab action or an in-flight per-tab connect fired the auto-save
  subscription, and the auto-save recaptured the whole live tree — persisting
  tabs that were still connecting or in an agent-error state over the good
  `last-session.json`. A `restoreInProgress` guard now skips auto-save from when
  a restored/launched layout is placed until the cohort settles, so only a
  stable layout is captured (audit gap G5, #1146).
