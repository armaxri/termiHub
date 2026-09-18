# PER-008: credential envelope version-range migration

## Changed

- The encrypted credential store now accepts a **range** of envelope format
  versions on read (`MIN_SUPPORTED_ENVELOPE_VERSION..=ENVELOPE_VERSION`) instead
  of a single exact version, and always writes the current version — so a future
  format bump can upgrade existing vaults transparently on their next save
  instead of orphaning them.

## Fixed

- Unlocking a credential store that was written by a **newer** version of
  termiHub (for example after an auto-update was rolled back) now shows a clear
  "credential store was written by a newer version of termiHub — update termiHub
  to unlock" message instead of reporting the store as corrupt. A recoverable
  downgrade no longer looks like data loss, and no destructive "reset store"
  action is offered for it.
