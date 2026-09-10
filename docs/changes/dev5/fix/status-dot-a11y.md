### Fixed

- Status dots across the app now carry a text alternative so their meaning no
  longer depends on colour alone (WCAG 2.1 Level A — 1.4.1 Use of Color, 1.1.1
  Non-text Content). The shared sidebar status dot (embedded servers, SSH
  tunnels), the terminal tab connection dot, the persistent-session run-state
  dot, and the remote-agent connection dot are each exposed to assistive
  technology as an `img`-role graphic with an accessible name (e.g. "Running",
  "Stopped", "Error", "Connected", "Connecting", "Reconnecting",
  "Disconnected"). Screen-reader and keyboard-only users can now perceive
  connection and run-state without relying on the previous hover-only `title`
  or colour.
