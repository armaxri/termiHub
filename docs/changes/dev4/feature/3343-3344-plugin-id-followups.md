### Added

- A saved connection whose plugin is not installed, disabled or not trusted is now marked
  in the sidebar with a badge naming the plugin and why it is unavailable; connecting says
  so instead of failing with an unknown-type error, and the context menu opens the plugin
  manager to install or enable it. The marker clears as soon as the plugin is available
  (#3344).

### Fixed

- Connections in external connection files and in imported connection or workspace
  exports that still carry an old plugin connection-type id now bind to the installed
  plugin, like connections in the main store (#3343).
- Loading an external connection file that contained a plaintext password no longer drops
  its connections inside folders when the file is rewritten (#3343).
