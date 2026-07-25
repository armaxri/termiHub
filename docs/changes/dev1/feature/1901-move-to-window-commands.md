### Added

- Move a session tab to another window from its context menu (#1901, epic
  #1899): a session tab's right-click menu now has a **Move to New Window**
  command that tears the tab out into a fresh window, and a **Move to Window ▸**
  submenu listing the other open windows (with **New Window** on top and the
  current window shown disabled) for moving the tab into an existing window. The
  move re-parents the live session through the #1900 hand-off seam, so the
  backend session (PTY / SSH / serial) keeps running. **Move Tab to New Window**
  is also reachable from the command palette. Only session-bearing tabs offer
  the commands; graphical (RDP/VNC) tab moves remain a follow-up (#1904).
