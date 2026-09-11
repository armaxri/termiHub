### Fixed

- The remote agent's persistent-session state file (`state.json`) is now
  crash- and corruption-safe, so a restart no longer silently loses recoverable
  sessions (PER-006 / AGT-017). A file that is present but unparseable is no
  longer discarded with only a warning: its bytes are quarantined to a
  `state.json.corrupt-<n>` sibling (preserving every recoverable session for
  salvage) and a loud error names the backup path before the agent continues
  with empty state. The state file also carries a schema `version` field now,
  written on every save and read tolerantly so a pre-versioning file still loads
  (full migration handling is tracked in #2744). Atomic temp-file + fsync +
  rename writes (already in place, #2366) mean a torn write can never corrupt the
  live file.
