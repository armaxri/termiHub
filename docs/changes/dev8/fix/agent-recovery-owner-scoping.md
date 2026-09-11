### Fixed

- Opening a second desktop against the same host no longer steals the first
  desktop's live persistent terminals. A remote agent worker recovering
  sessions on startup now declares a recovery intent, and the session daemon
  refuses to evict a connection another live worker is still actively attached
  to — recovering only its own or truly-orphaned sessions (AGT-015).
