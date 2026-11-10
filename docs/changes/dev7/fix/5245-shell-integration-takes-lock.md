### Fixed

- Portable mode: `install-shell-integration` / `uninstall-shell-integration` no
  longer rewrite the portable `data/settings.json` while termiHub is running from
  the same folder, which could lose a settings change made in the app. The
  command now refuses with a message (use Settings in the running termiHub, or
  close it first), changes nothing, and exits with code 1. Installed mode is
  unchanged (#5245).
