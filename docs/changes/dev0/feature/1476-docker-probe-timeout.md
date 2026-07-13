### Fixed

- Agent startup no longer hangs when Docker is installed but unresponsive
  (stopped, hung, or a slow socket). The Docker availability probe run during
  the agent's `initialize` handler is now time-bounded (default 2s, overridable
  via `TERMIHUB_DOCKER_PROBE_TIMEOUT_MS`); on timeout or error it degrades to
  "Docker unavailable" instead of blocking indefinitely (#1476).
