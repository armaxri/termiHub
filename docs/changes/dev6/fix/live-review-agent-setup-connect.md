### Fixed

- Remote agents: after a setup starts on a Linux or macOS host, the agent row keeps "Installing…"
  until the setup has finished and its install path is saved, instead of offering Connect at once,
  where a connect read "Agent not installed". A setup that did not install drops the row's
  "Installing…".
