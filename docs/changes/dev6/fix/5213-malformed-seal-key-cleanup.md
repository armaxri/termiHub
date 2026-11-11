### Fixed

- Backup restore: a damaged deferred credential import no longer leaves its
  temporary seal key behind in the OS keychain, and an import whose file is
  not even text is dropped once instead of being retried at every start
  (#5213).
