### Added

- Terminal-less connection types now open straight into a browser-only tab
  instead of a dead terminal. Connection backends declare a new `terminal`
  capability flag (defaulting to terminal-capable for backward compatibility);
  FTP reports `terminal: false` and its tab renders a file-browser placeholder
  while the sidebar file browser handles navigation and transfers. Every
  existing terminal connection type is unaffected (#1335).
