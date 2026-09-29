### Fixed

- `termihub --list-workspaces` now prints the saved workspaces even while termiHub is
  already running. Before, the second process exited silently with no output. The listing
  honours `TERMIHUB_CONFIG_DIR` and portable mode, never modifies the workspace file, and
  exits non-zero if the file cannot be read (#3854).
