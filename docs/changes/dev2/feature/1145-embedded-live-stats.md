### Fixed

- The embedded server sidebar now shows live traffic and uptime. Previously the
  status broadcast on every server transition carried zeroed stats and no start
  time, so the traffic line always read `0 conn · ↑0 B ↓0 B` and uptime never
  appeared, even under load. The backend now snapshots the running server's real
  stats and start time into the status payload, and while any server is running
  the frontend polls the live states (every 1.5s) so the traffic line and uptime
  update continuously instead of only on start/stop transitions. Addresses GAP G6
  of the embedded servers state-machine audit (#1145).
