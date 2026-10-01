### Added

- Network Tools: the DNS Lookup panel's Server field now also accepts a resolver
  on a non-standard port as `ip:port` (or `[ipv6]:port`), e.g. `127.0.0.1:5353`.
  A bare IP still queries port 53 (#3692).

### Fixed

- Network Tools: on macOS, the Open Ports viewer showed `(LISTEN)` instead of the
  address for every listening TCP port. It now shows the real local address and
  port (#3692).
