### Fixed

- Connection-failure hints are now backend-appropriate. An SSH connect timeout
  previously showed "Check that the host is reachable and the agent binary is
  installed" — an agent-connection hint that is wrong on the SSH path (and, in
  fact, on every path: a timeout means the transport never connected, so the
  remote agent binary cannot be the cause). Timeout guidance is now sourced from
  a structured per-backend table so each backend (SSH, telnet, serial, Docker,
  local) gets a hint written for it, and the SSH ssh-agent hint no longer leaks
  onto non-SSH backends (#2088).
