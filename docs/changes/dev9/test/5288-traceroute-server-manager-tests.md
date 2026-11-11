### Fixed

- Traceroute on macOS no longer risks reporting a responding hop as a timeout
  when a router sends an extended (RFC 4884) ICMP reply: the reply is now read
  by its IP header length rather than the raw socket's `ip_len` field, which
  BSD-derived systems may hand over in host byte order (#5288).
