### Added

- RDP: a direct connection (no SSH tunnel) can reach the RDP server through a SOCKS4,
  SOCKS5 or HTTP (`CONNECT`) proxy, set in the collapsed **Proxy** group (shown only with
  the SSH tunnel off). termiHub dials the proxy itself and hands the RDP sidecar a local
  port, so the proxy password — kept in the credential store and asked for at connect time
  when a Proxy User is set — never reaches the sidecar, and NLA and TLS still name the real
  server. A proxy cannot be combined with connecting through an agent (#4899).
