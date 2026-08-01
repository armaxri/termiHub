### Fixed

- Port Scanner now streams a large scan through a bounded worker pool instead of
  pre-spawning one connect task per `(target × port)` combination. A wide scan
  (e.g. a CIDR range across the full port range) previously allocated a join
  handle for every combination up front — millions of tasks/handles at once — a
  memory and file-descriptor blowup. Probes are now capped at the configured
  concurrency and reaped as they complete, so resource use stays bounded no
  matter how large the target × port product is. Results, ordering, and the
  per-connect timeout are unchanged for normal scans (#2345).
