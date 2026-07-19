### Added

- VNC connection editor: the display number and TCP port now stay in sync.
  Entering a display number auto-fills the port to `5900 + display`, and editing
  the port directly clears the display so the explicit port wins — matching the
  connect-side resolution. Clearing or entering an out-of-range/non-numeric
  display leaves the port untouched, so a deliberately custom port is never
  overwritten (#1716).
