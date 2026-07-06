### Fixed

- Terminal tabs now show a connection status dot that actually renders and
  reflects the live session state — connecting, connected, failed, or
  disconnected. Previously the dot never appeared (it was wired to a dead,
  mismatched state source). The dot updates on background (inactive) tabs too,
  so you can see a connection drop or fail without first focusing the tab.
