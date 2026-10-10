### Fixed

- Backup: a restore into the OS keychain is now all-or-nothing across a restart. Its credentials are
  sealed (never stored in plain text) and imported only after the restored data was swapped in
  successfully at the next start, so a restore that fails and is rolled back leaves the keychain
  exactly as it was, and the warning says nothing changed (#4414).
