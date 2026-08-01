### Fixed

- Workspace persistence now writes its files atomically (temp file + rename)
  instead of truncating them in place. Previously an interrupted save — a crash,
  power loss, or full disk mid-write — could leave `workspaces.json` or
  `last-session.json` truncated; on the next launch the corrupt file was
  discarded, silently wiping every saved workspace and the restored session. An
  atomic replace guarantees the file always holds either the complete previous
  contents or the complete new contents, so an interrupted save never loses
  existing data (#2318).
