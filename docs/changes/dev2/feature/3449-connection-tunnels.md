### Added

- SSH connection editor: a new **Port Forwarding** section lists the tunnels
  attached to the connection and lets you add, edit and remove local (`-L`),
  remote (`-R`) and dynamic SOCKS (`-D`) forwards right from the connection.
  They are the same tunnels shown in the Tunnels sidebar (PROD-023, #3449).
- Tunnels have a new **Start with connection** option: forwards marked with it
  start automatically whenever a terminal to their SSH connection connects
  (already-running forwards are left alone). Existing tunnels keep the option
  off (#3449).
