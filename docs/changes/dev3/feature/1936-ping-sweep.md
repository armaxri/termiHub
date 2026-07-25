### Added

- **Ping Sweep** network tool: discover live hosts across a subnet or IP range.
  Enter a CIDR block (e.g. `192.168.1.0/24`), an IP range, or a comma-separated
  mix; termiHub enumerates the hosts and ICMP-pings each concurrently (with the
  same TCP-connect fallback as single-host Ping where raw ICMP needs
  privileges), streaming responders into a live table with RTT and best-effort
  reverse-DNS name. Non-responders are tallied in the footer. A wide range warns
  before sweeping (with a "Don't warn again" opt-out, mirroring the Port
  Scanner), and Stop cancels mid-sweep. Launch it from Network Tools →
  Quick Actions → "Ping Sweep…". New `warnLargePingSweep` general setting backs
  the warning (#1936).
