### Fixed

- Remote desktop: the first connect of a VNC or RDP tab can no longer hang on "Connecting…"
  forever. It now gives up after the connection's connect timeout (30 s by default) and
  shows "Could not connect" with a Reconnect button, like a failed reconnect does.
- Remote desktop: the connecting overlay now has a Cancel button, and closing a tab that is
  still connecting aborts the connection right away.
