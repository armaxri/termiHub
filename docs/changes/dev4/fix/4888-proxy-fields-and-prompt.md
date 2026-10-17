### Changed

- SSH connection editor: the Proxy Host, Port, User and Password rows now appear only when a
  Proxy Type is chosen, and Proxy Password is hidden for SOCKS4, which has no password
  support (#4888).

### Fixed

- Connecting through an SSH proxy with a Proxy User but no saved Proxy Password now asks for
  the password (with the usual Save box) instead of failing with the proxy's
  "authentication failed" error (#4888).
