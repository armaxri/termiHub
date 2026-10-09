### Changed

- When another host updates a remote agent, termiHub now reconnects to the
  updated agent once for the whole app instead of once per open window. The
  backend suspends the connection, waits for the agent's restart, and retries
  with the shared reconnect backoff for up to two minutes; every window shows
  the same notice and its outcome (reconnected, failed with a manual
  Reconnect, or stopped). Cancel in any window stops the reconnect everywhere,
  and a manual connect, disconnect, shutdown or delete of the agent takes over
  from it.
