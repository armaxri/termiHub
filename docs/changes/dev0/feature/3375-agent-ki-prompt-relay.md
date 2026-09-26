### Added

- SSH connections that a remote agent authenticates (agent-hosted SSH sessions, agent tunnels,
  agent monitoring) now show the same one-time-code / 2FA dialog as a direct connection, labelled
  with the agent that relays it, and connect once the code is entered. Previously any OTP prompt on
  those connections failed with "no prompt is available here" (#3375).
