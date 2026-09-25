### Fixed

- Changing the connection type of an existing connection saved on a remote agent
  is now applied. The editor sent the type under the wrong key, so the agent
  silently kept the old type. The desktop now validates the agent
  connection/folder create and update requests against the shared protocol types
  and rejects a malformed request with a clear error instead of forwarding it
  (#3349).
