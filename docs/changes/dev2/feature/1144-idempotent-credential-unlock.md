### Fixed

- Credential store: unlocking an already-unlocked master-password store is now
  a benign no-op instead of an error. Previously, when two connect flows raced
  to unlock the store, the second unlock returned "Store is already unlocked",
  which surfaced as a spurious "Incorrect master password"-style failure even
  though the store was fine. Unlock is now idempotent and still emits the
  unlock event so any awaiting connect flow resolves. Wrong-password behavior
  on a locked store is unchanged (#1144, G6).
