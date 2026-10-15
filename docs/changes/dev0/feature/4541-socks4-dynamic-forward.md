### Added

- SSH tunnels: dynamic (`ssh -D`) tunnels now accept SOCKS4 and SOCKS4a clients on the same
  port as SOCKS5, matching OpenSSH. SOCKS4a hostnames are resolved from the SSH server's
  network. Clients that only speak SOCKS4 no longer have their connection closed (#4541).
