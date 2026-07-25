### Changed

- Multi-window: the Open Connections panel's owning-window badge now appears for
  **every** session when more than one window is open — not only for sessions
  that were moved between windows. Each window now claims ownership of the
  sessions it renders (on session open, attach, and restore), releasing it when
  the tab closes or the session ends, so every session row can show which window
  owns it. Single-window behaviour is unchanged (#1939).
