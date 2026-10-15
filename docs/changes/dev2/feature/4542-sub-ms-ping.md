### Changed

- Ping, ping sweep and port scan now measure latency with sub-millisecond
  precision: a 0.42 ms LAN reply reads "0.42ms" instead of 0 ms or 1 ms, in
  the results table, the live stats line, the latency graph and the CSV
  export. Precision scales with the value (two decimals below 10 ms, one below
  100 ms, whole milliseconds above). Mixed versions keep working: an older
  agent still reports whole milliseconds, and a newer agent rounds for an
  older desktop (#4542).
