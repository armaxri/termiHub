### Fixed

- SSH tunnel port-forwarders (local `-L`, dynamic `-D` SOCKS5, and remote `-R`)
  now bound the number of connections they relay concurrently. Each forwarded
  connection ties up an SSH channel, a relay task, and buffers, and a local
  listener is reachable by any local process — so previously an aggressive or
  buggy client could open unbounded forwarded channels and exhaust the SSH
  connection's channel budget and host memory. A per-forwarder cap now drops
  (closes) connections that arrive while it is at capacity, freeing a slot the
  moment a relay ends (CORE-027).
- Session monitoring no longer leaks a background collector task when monitoring
  is (re-)started or stopped mid-startup. Starting monitoring again for a session
  (a re-subscribe or run-location change) now aborts the previous collector
  instead of orphaning it — which had let two collectors race on the same data
  and show flickering or doubled stats — and a stop that arrives while a monitor
  is still starting now reliably aborts it (CONC-006).
