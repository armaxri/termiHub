### Fixed

- Switching the credential store no longer reports "Switched successfully" when some or
  all credentials failed to migrate. The switch result now carries a structured status
  (`success`, `partial`, `failed`) plus a failed count, computed from the real
  per-credential outcomes. Settings shows a clean confirmation on success, an
  informational notice listing what could not be moved on a partial migration, and an
  error on a total failure that points you back to the previous store, where the
  unmigrated credentials remain intact (#2839).
