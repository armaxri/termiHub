### Added

- CLI/context-menu spawn: an external `termiHub spawn` for a local/WSL/SSH
  target now opens a session inside the running app. The window is focused, a
  shell tab opens `cd`'d to the target directory, and a toast confirms the
  action. The target path is resolved sensibly — a folder opens in itself, a
  file opens in its parent directory, and a missing path opens your home
  directory with a warning toast (symlinks are resolved; a WSL target is mapped
  to its `/mnt/` path). Spawns that arrive on a cold start (before the UI is
  ready) are queued and processed once the app finishes loading. Complements the
  already-shipped "new container" spawn path. Part of the Shell Context Menu &
  CLI Spawn Integration epic (#1363, #1365).
