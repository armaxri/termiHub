### Fixed

- Accessibility: screen readers now announce when a terminal connection fails, a reconnect or
  authentication fails, a session is lost, a session disconnects, an automatic reconnect is
  pending, or an agent was disconnected. Failures are announced immediately with their error;
  disconnects are announced politely. The overlay's message is its accessible description, and in
  the active tab keyboard focus moves to its main action (Retry, Try Again, Reconnect or Start New
  Shell) without stealing focus from other tabs, panels or dialogs (#4331).
