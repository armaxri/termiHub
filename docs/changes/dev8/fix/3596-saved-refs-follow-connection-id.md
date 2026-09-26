### Fixed

- Renaming or moving a saved connection, or renaming, moving or deleting a folder above it, no
  longer breaks what refers to it: saved workspaces, the tabs restored at the next start, SSH
  tunnels, broadcast groups, "Open in termiHub" entries, scheduled runs, workflow on-connect
  triggers and jump-host references in other connections (also in external connection files)
  now follow the connection to its new place. Recent sessions keep showing the name the
  connection had when it was opened. (#3596)
