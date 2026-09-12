### Added

- Transfer Queue rows now show an estimated **time remaining** (e.g. `~3m 05s left`)
  and a **transferred / total** byte count (e.g. `45 MB / 120 MB`) alongside the
  existing percent and throughput. The ETA is derived from the transfer's speed and
  bytes remaining (preferring a backend-supplied estimate when present) and lightly
  smoothed so it does not flicker. For indeterminate transfers whose total size is
  unknown, the row now shows the transferred bytes so far — previously the percent
  cell was simply blank — and omits the ETA.
