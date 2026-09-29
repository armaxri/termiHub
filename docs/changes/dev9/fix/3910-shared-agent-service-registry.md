### Fixed

- Embedded servers and HTTP monitors running on an agent started with `--listen`
  are no longer lost when the desktop disconnects. Before, the next connection
  could not see, stop or query them, while the servers kept listening. Now they
  stay reachable from the next connection. Starting a service the agent already
  runs no longer fails with "already running".
