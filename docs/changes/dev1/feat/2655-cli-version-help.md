### Added

- The desktop binary now handles the top-level `--version`/`-V` and
  `--help`/`-h` flags itself: it prints the version (or a short usage summary
  listing the flags and subcommands the binary honors) and exits 0 without
  starting the GUI, the bridge, or any window. Both are routed from the raw
  process arguments before any Tauri/window setup, so they work headlessly with
  no display — making a display-independent `termihub --version` check possible
  in CI (#2655).
