### Changed

- External `termiHub spawn` now opens WSL and SSH targets with their real
  backends instead of a local shell. `termiHub spawn --kind wsl --location
<winpath>` opens a WSL distribution session at the converted `/mnt/` path
  (distribution taken from the saved WSL connection referenced by
  `--connection`, otherwise the system default distro), and `termiHub spawn
--kind ssh --connection <id> --location <path>` opens the saved SSH connection
  and `cd`s into the target after connect (SSH cannot set a start cwd at spawn).
  An SSH spawn with a missing, unknown, or non-SSH `--connection` now surfaces a
  clear error toast rather than silently falling back to a local shell. Local
  spawns are unchanged (#1511, follow-up to #1365).
