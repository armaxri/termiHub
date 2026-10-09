### Fixed

- Accessibility: after you reconnect a terminal from its overlay (Reconnect, Try Again,
  Retry or Start New Shell), focus goes back to the terminal once the session is up again.
  Keyboard and screen-reader users no longer have to find the terminal themselves. Focus
  only moves if it is on the page body or still in the tab's panel. A dialog, the sidebar
  or another panel that you moved to in the meantime keeps focus (#4513).
