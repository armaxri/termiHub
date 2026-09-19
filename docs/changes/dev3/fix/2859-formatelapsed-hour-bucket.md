### Fixed

- Elapsed and ETA labels no longer overflow the minutes unit for long spans. A duration of
  two hours previously rendered as `120m 00s`; it now rolls over cleanly into hours and days
  (`2h 00m`, `1d 03h`). This affects transfer ETAs (`~… left`) and the connection overlay's
  elapsed timer (#2859).
