### Added

- HTTP monitors now surface up/down transitions as toast notifications
  app-wide, regardless of which view is on-screen. When a monitored endpoint
  goes down you get an error toast; when it recovers you get a success toast.
  Only the transition edge fires (not every poll), so a persistently-down
  endpoint is reported once, and a monitor's first check establishes a silent
  baseline. Previously an up/down change was silent unless the Network Tools
  sidebar or HTTP Monitor panel happened to be open (#1147).
