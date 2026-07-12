### Fixed

- Network Tools › Traceroute no longer shows `avg NaNms` (or a misleading
  `0ms`) in the completed footer when the final hop never answered — the
  average is omitted when there is no valid round-trip to average. (#1359)

### Changed

- Network Tools › Traceroute now appends a "Trace canceled" footer after Stop
  instead of silently freezing the results table. (#1359)
- Network Tools › Ping surfaces running loss %, RTT min/avg/max and jitter live
  from the streamed replies while the ping is in progress, rather than hiding
  all statistics until Stop. (#1359)
- Network Tools › Port Scanner's running footer now shows a live open-port count
  alongside the number of ports checked. (#1359)
- Network Tools › DNS Lookup bounds each query with a visible timeout and offers
  a Cancel button while the lookup is in flight, so a hung resolver can no
  longer leave the panel spinning. (#1359)
- Network Tools › Open Ports auto-loads the listening ports on mount; Refresh
  remains for an explicit re-fetch. (#1359)
