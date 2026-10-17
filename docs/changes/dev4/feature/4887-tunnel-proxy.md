### Added

- VNC and RDP: the **SSH Tunnel** group can reach its SSH host through a SOCKS4, SOCKS5 or
  HTTP (`CONNECT`) proxy (Proxy Type, Host, Port, User and Password rows, shown with the
  tunnel on). The proxy password is kept in the credential store, asked for at connect time
  when a Proxy User is set, and never reaches the RDP sidecar (#4887).
- MobaXterm import: a VNC session's SOCKS4, SOCKS5 or HTTP proxy becomes the SSH tunnel's
  proxy when the session has a single SSH gateway; without one it stays a preview note
  (#4887).
