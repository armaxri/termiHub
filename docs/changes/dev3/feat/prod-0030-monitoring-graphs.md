### Added

- The connection monitor now keeps a short **rolling history** of each metric on
  the client and graphs it. The status-bar monitoring dropdown shows compact
  sparklines for CPU, memory, swap (when the host has swap) and network
  throughput (down/up) alongside the live numbers, and a new **View history**
  action opens a monitoring history panel with larger time-series charts for the
  same metrics over the recent window. History is reconstructed client-side from
  the existing per-sample stream — no backend change — and resets on disconnect
  or reconnect so a gap is never graphed as continuous. A just-connected or idle
  monitor shows a loading state rather than an empty chart (PROD-0030).
