### Changed

- The agent update strip offers "Later" instead of "Close", which beside "Waits for 1 session
  (…) to close." read as closing the session. A line under "Restart agent and update" says the
  open sessions keep running, and each session name stays on one line (#5980).
- After you disconnect an agent, its tab's banner says "Agent disconnected. Press Enter to
  resume." and screen readers hear the same text. They used to be told Reconnect starts a new
  session, while it resumes the session (#5980).
- Tabs grow up to 360px before their title is shortened, so an agent tab
  ("<agent> · bash") and its "Setup: <agent>" tab show their full name while the strip has
  room. A setup tab too narrow for its name is shortened from the end, like an agent tab. The
  tooltip always shows the full title (#5980).
- A setup tab whose setup finished shows a "Finished" check instead of the red disconnected
  plug, and the status bar no longer shows its SSH chip. A failed setup keeps the red plug
  (#5980).
- An expanded, disconnected agent reads "Not connected." and keeps the row's Connect icon as
  the only Connect action (#5980).
