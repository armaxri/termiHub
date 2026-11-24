### Fixed

- Agent: disconnecting or shutting down an agent no longer writes
  "— connection lost —" into its tabs. The tabs now read
  "— disconnected by you hh:mm:ss —", like any link you end yourself, while a
  real network drop still says "connection lost" (#5959).

### Added

- Agent: "Active sessions" marks each session that an open tab shows with a
  small "Open in a tab" icon. Clicking or opening that row brings its tab
  forward instead of opening a second tab on the same session (#5960).
