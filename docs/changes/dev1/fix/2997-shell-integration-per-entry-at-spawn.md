### Fixed

- A Shell Integration entry's saved connection (the per-entry "saved connection"
  set in the settings UI) is now honored when the entry is triggered from a
  file-manager context menu. Registration emits `spawn --entry-id <id>` without a
  `--connection`, and the spawn resolver only read an explicit `--connection` —
  so an SSH entry with a saved connection failed with "an SSH spawn requires a
  saved connection", and a WSL entry silently fell back to the default
  distribution. The resolver now falls back to the entry's saved `connectionId`
  when no explicit connection is passed (an explicit `--connection` still wins),
  so SSH/WSL entries open their configured connection (#2997).
