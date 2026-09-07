### Fixed

- The HTTP Monitor now always shows the immediate first check. The backend runs
  a check the moment a monitor starts, and that result could arrive before the
  panel learned the monitor's id, so it was dropped and the panel stayed blank
  until the next check — up to 30s away at the default interval — on a
  fast-responding target such as loopback. The panel now buffers such early
  checks and reconciles them once the id is known (#2684).
- Ping now reports a result for hosts that are reachable over TCP but block or
  silently drop ICMP echoes (e.g. sandboxed environments). Previously ping fell
  back to a TCP probe only when the ICMP socket could not be created; a
  created-but-unanswered ICMP echo timed out forever. If the first ICMP echo
  times out while the host answers or refuses a TCP connection, ping switches to
  the TCP measurement (flagged as a TCP ping) for the rest of the session
  (#2684).
