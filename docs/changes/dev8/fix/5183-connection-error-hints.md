### Changed

- Connections: a connect that fails because the port is closed, the host is
  unreachable or its name does not resolve now says so — "Connection refused",
  "Host unreachable" or "Host not found" — with a plain-language hint instead of
  the raw operating-system error. The technical error is still one click away
  under "Details", with a copy button, and the message no longer stacks
  prefixes like "Failed to spawn terminal: Spawn failed:" (#5183).

### Added

- Connections: a failed connect of a saved connection offers **Edit
  connection**, which opens its editor on the port (for a refused connect) or
  the host field, so a wrong address is fixed in one step instead of retrying
  into the same error (#5183). Agent-hosted sessions get the same hints with an
  agent of protocol 0.35.0 or newer.
