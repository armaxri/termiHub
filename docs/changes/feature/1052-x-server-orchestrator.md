### Added

- SSH X11 forwarding: a cross-platform X server provisioning orchestrator now
  runs when opening a connection with X11 forwarding enabled. It adopts an
  already-running local X server on any platform, and when none is present
  surfaces a clear, actionable error (install/launch guidance per platform)
  instead of a silent no-op. New global settings back it:
  `provideXServerAutomatically` (defaults to prompt-then-download on Windows,
  off elsewhere) and `stopXServerWhenIdle` (default on). Backend commands
  `x_server_status` / `x_server_ensure` / `x_server_stop` /
  `x_server_install_dependency` and a `x-server-progress` event expose the
  subsystem to the UI (settings and Open Connections surfaces land in #1053).
  Automatic VcXsrv provisioning on Windows is not yet available — that arrives
  with #1048–#1050 (#1052, epic #1047).
