### Added

- Plugin capability bridge: mediated filesystem **writes** and **directory
  inspection**. Building on the read/connect surface from #2018, the
  `PluginHostBridge` now also mediates `write_file` (create / truncate / append),
  `stat`, and `list_dir` — each routed through the session's declared
  `FilesystemScope`, so a plugin can only write to, stat, or list paths inside its
  granted roots and out-of-scope or `..`-traversal paths are refused before the
  host performs any I/O. The mediated `open_connection` also gained a host-side
  connect timeout so a plugin's dial-out to a black-holed host can no longer hang
  a session. The plugin ABI (`termihub-plugin-api`) is bumped to version 3 to
  reflect the grown bridge vtable (#2024).
