### Fixed

- Deleting a saved connection now cleans up everything that referenced it, so no
  stale leftovers remain: any running background (persistent) session for that
  connection is stopped and its orphaned status badge/reconnect target is
  removed, open terminal tabs that came from it keep working but stop pointing at
  the deleted connection, and any SSH tunnel that used it is flagged as now
  referencing a deleted connection instead of silently becoming unresolvable.
