### Added

- Tunnel sidebar rows now show the total connection count alongside the active
  count for a running tunnel (`active / total conn`), surfacing the cumulative
  total the stats already tracked.

### Changed

- Splitting a pane is now prevented when the resulting pane would be too small
  to be usable — the split is blocked with a brief "Pane too small to split
  further" notice instead of producing an unusable sliver.
