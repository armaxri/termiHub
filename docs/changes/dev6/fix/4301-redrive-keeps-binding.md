### Fixed

- A tab that reconnected automatically now stays linked to its saved
  connection. Before, the reconnected session lost the link: a transfer started
  on it could not be relaunched or re-source its secret after a restart, and
  transfers paused by the drop did not resume when the reconnect succeeded. A
  reconnected tab now behaves exactly like a freshly opened one, for direct,
  SSH and agent-hosted connections and for persistent sessions, and it keeps
  the stored field secrets of its saved connection across repeated reconnects
  (#4301).
