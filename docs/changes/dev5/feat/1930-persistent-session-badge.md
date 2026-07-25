### Added

- Persistent sessions: the sidebar run-state dot now carries a numeric count
  badge when a session is attached to more than one tab (e.g. ●²), in both the
  desktop-local Connections tree and the agent-hosted tree. Hovering the dot
  lists the attached tab names. Closing a tab attached to a persistent session
  now shows a one-time notice that the session keeps running in the background
  (use Stop in the sidebar to terminate it), with a "Don't show again" opt-out.
  A new General setting, "Notify When Closing a Persistent-Session Tab",
  re-enables the notice after opting out (#1930).
