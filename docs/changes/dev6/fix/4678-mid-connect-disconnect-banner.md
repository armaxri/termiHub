### Fixed

- Agents: disconnecting or shutting down a remote agent while it is still connecting now shows the
  "Agent disconnected" banner on its open terminal tabs in every window, the same as for a
  connected agent, instead of the plain disconnected overlay. The banner and any on-disconnect
  workflow triggers still fire exactly once (#4678).
