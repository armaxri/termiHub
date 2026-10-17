### Added

- VNC: a direct connection (no SSH tunnel) can reach the VNC server through a SOCKS4,
  SOCKS5 or HTTP (`CONNECT`) proxy, set in the collapsed **Proxy** group (shown only with
  the SSH tunnel off). The proxy password is kept in the credential store and asked for at
  connect time when a Proxy User is set. With the tunnel on, the SSH Tunnel group's own
  proxy rows apply instead (#4897).
- MobaXterm import: a VNC session's SOCKS4, SOCKS5 or HTTP proxy without an SSH gateway
  becomes the connection's own proxy instead of a preview note (#4897).
