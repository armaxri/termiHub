### Changed

- The default SSH connect timeout is now **45 seconds** (raised from 20 s). The
  budget covers the whole connect — DNS resolution, the TCP connect, and the SSH
  handshake — so a host that resolves slowly on the first attempt of the day
  (cold DNS, e.g. a home Raspberry Pi) no longer fails a too-tight 20 s window of
  which most was spent resolving. The value stays configurable per connection via
  the **Connect Timeout (s)** field (and per jump-host hop), so a slower or
  faster budget can still be set where needed (#2087).
