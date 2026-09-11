### Fixed

- User data is no longer lost when a save is interrupted by a crash, power loss,
  or full disk. Several persisted stores were written with a plain, non-atomic
  file write that truncates the existing file before writing the new contents, so
  an interrupted save left invalid JSON that the recovery paths discard — wiping
  the saved data. Workflows, macros, session history, SSH tunnels, and the SSH
  and RDP host-key trust stores now write atomically (temp file + fsync + rename),
  matching the connection, workspace, settings, last-session, and agent-state
  stores, so a torn write can never lose the previous contents (PER-002, PER-003).
