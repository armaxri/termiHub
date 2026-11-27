### Fixed

- Tunnels: a tunnel whose start failed (the SSH server refused, closed or did not answer in time)
  no longer keeps showing "connecting"; it shows the error and why, and Stop clears it (#6139).
- Tunnels: a forwarded connection whose target refuses is now counted as refused on a Windows SSH
  server too, which opens the connection before the target answers and then closes it (#6139).
