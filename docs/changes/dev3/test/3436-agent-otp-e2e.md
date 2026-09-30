### Fixed

- Agent-hosted SSH sessions: when the connect fails for a reason without a
  dedicated error type, the error now names that reason (for example "no
  prompt is available here" when the server asks for a one-time code) instead
  of only saying the session daemon exited.
