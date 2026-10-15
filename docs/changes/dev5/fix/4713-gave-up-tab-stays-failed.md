### Fixed

- Remote agent: when an agent's automatic reconnect gives up, its terminal tabs
  now stay in the "Reconnect failed" state with the give-up error until you
  reconnect them yourself. Previously, a moment later the tabs could flip back
  to "Reconnecting" (and start retrying on their own) or to a plain
  "Disconnected" state that dropped the error (#4713).
