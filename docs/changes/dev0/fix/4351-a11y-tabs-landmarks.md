### Fixed

- Accessibility: screen readers now announce a terminal tab's unsaved, broadcast
  and persistent-session state, instead of nothing or "infinity" (#4351).
- Accessibility: tabs and tab-group chips no longer contain nested buttons. Press
  Delete or Backspace on a focused tab or chip to close it. The tab context menu
  now has "Close Tab" and, when another window has taken over the session, a
  "Focus <window>" item (#4351).
- Accessibility: the activity bar, sidebar, terminal area and status bar are now
  navigation, complementary, main and contentinfo landmarks, so they can be
  reached with landmark navigation (#4351).
- Accessibility: the agent setup install path, the remote desktop clipboard text
  box and the tunnel editor's SSH connection and host pickers now have accessible
  names (#4351).
