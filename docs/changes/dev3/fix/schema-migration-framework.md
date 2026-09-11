### Fixed

- Configuration files (connections, workspaces, last session, session history,
  workflows, and settings) are now protected against data loss on a downgrade
  or a staged auto-update rollback. Each store's `version` field is finally read
  on load: a file written by a **newer** version of termiHub is left completely
  intact and reported as a warning instead of being silently reset to defaults,
  and a save can no longer overwrite such a newer file. Previously an older
  build treated a newer file it could not parse as "corrupt" and wiped it to a
  `.bak` (PER-004), or dropped any fields the newer version had added on the
  next save (PER-010). Unknown fields now round-trip verbatim, and a real
  schema-migration mechanism is in place so future schema changes upgrade older
  files forward on load (PER-001). Session-history and workflow files are also
  now written atomically, closing a torn-write data-loss window (PER-002/003
  class).
