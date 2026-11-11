### Fixed

- SSH remote (`-R`) tunnels: stopping a tunnel now also closes its listener on
  the SSH server right away, instead of leaving the port open until the SSH
  connection ended. When the server drops the connection of a running remote
  tunnel (on the desktop or on an agent), the tunnel is now reported as dead
  and can reconnect, instead of looking active with nothing behind it.
