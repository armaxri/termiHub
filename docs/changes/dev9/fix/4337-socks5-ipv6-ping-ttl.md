### Fixed

- SSH tunnels: dynamic (SOCKS5) tunnels now forward to IPv6 targets, and a failed
  connection returns the matching SOCKS5 error (for example "connection not allowed" or
  "host unreachable") instead of a generic failure. An unsupported address type now gets
  the correct "address type not supported" reply (#4337).
- Network tools: ping now reports the reply TTL where the platform provides it (ICMP over
  IPv4 on macOS, Windows and raw sockets) and rounds sub-millisecond round-trip times
  instead of truncating them to 0 ms. TCP ping says that TTL is not available over TCP
  (#4337).
