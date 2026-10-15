### Fixed

- The once-per-session guard for on-connect workflows now forgets a session when its tab
  closes, its session exits cleanly, or a reconnect opens a fresh session, instead of
  remembering every session for the life of the window. A reconnect that re-attaches the
  same session still does not re-run the workflows.
