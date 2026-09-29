### Fixed

- Embedded FTP server: the server now serves on the exact control socket it
  confirms at start, so another process can no longer take the port between the
  bind check and the real bind, and a port-0 server reports its real
  OS-assigned address (#3549).
- Agent-hosted SSH tunnels: local (`-L`) and dynamic (`-D`) forwards now report
  the address their listener actually bound, instead of the configured port
  (e.g. `127.0.0.1:0` for an auto-assigned port) (#3550).
