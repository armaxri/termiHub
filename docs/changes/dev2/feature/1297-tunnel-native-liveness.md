### Changed

- SSH tunnels now detect a dead SSH session **natively and event-driven** instead
  of polling. A tunnel whose SSH session dies (transport failure, peer disconnect,
  or keepalive miss) transitions to `Error` (or enters reconnect) promptly, driven
  by a russh session-liveness watch rather than the previous ~20 s keepalive probe
  that opened a throwaway SSH channel on every tick. Faster, quieter dead-tunnel
  detection with no extra channel churn; covers both direct and jump-host tunnels
  (#1297).
