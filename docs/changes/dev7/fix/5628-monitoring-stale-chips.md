### Fixed

- Stopping host monitoring from the status-bar host menu now really stops it: every metric chip
  goes away and a muted "Monitoring off · Start" item restarts it. Before, monitoring restarted
  by itself and Mem, Disk, Swap and Net stayed in the status bar (#5628).
- The monitoring host menu is compact and fits an 800×600 window: one row per metric (Disk
  included) with an inline sparkline, and the refresh interval is a single "Refresh: 2 s"
  submenu (#5628).
- A host without a stats source shows a muted "Monitoring unavailable" with an explanation
  instead of a red error and a Retry that could not help (#5628).

### Changed

- The status bar shows the SSH chip on every SSH tab (`user@host:port`, plus the bastion's
  host:port when jumping, auth method in the tooltip), shows port, baud rate and line settings
  for serial tabs, and keeps the credential lock in a fixed place on the right (#5628).
