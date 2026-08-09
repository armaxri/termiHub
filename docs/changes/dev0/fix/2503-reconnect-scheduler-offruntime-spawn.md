### Fixed

- Fixed a hard crash (SIGABRT) that could occur when a session's backend-driven
  reconnect timer was armed. The reconnect scheduler spawned its one-shot timer
  with the free `tokio::spawn`, but it is reached synchronously from a sync Tauri
  command that runs off the Tokio runtime — so the spawn panicked ("must be
  called from the context of a Tokio 1.x runtime") and aborted the app on the
  reconnect path. It now spawns onto Tauri's managed async runtime, which is safe
  from any thread (#2503).
