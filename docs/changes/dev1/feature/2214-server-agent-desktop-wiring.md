### Added

- Embedded HTTP/FTP/TFTP servers can now be hosted on a remote agent from the
  desktop. When a server's run-location is an agent, the desktop starts, stops,
  and polls its status on that agent over the `service.start` / `service.stop` /
  `service.status` agent RPC (protocol 0.7.0), and streams its running state back
  to the Embedded Servers sidebar and Open Connections exactly like a
  desktop-hosted server. A new `set_embedded_server_run_location` command records
  which machine hosts each server; the run-location selector UI that surfaces it
  lands in a follow-up. Desktop-hosted servers are unchanged (#2214).
