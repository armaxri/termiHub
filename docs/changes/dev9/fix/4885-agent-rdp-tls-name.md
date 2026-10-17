### Fixed

- An RDP connection routed through an agent now presents the real server name for TLS and
  NLA instead of `127.0.0.1`, so Kerberos-based network level authentication works over the
  agent tunnel (#4885).
