### Fixed

- Closing a whole tab group now cleans up each of its tabs the same way closing a single tab does:
  per-tab state, broadcast membership, persistent-session attachments and session ownership are
  released instead of lingering for the life of the window (#4453).
