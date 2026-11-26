### Fixed

- Repainting a terminal from a large scrollback (re-attaching to a session, moving a tab to another
  window, getting a session back from another window, a reconnect) no longer freezes the window on a
  slow machine while it is drawn: it is written in parts, like a flood of output since #6074. (#6087)
