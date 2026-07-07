### Added

- HTTP monitors in the Network Tools sidebar now show a relative "checked N
  ago" label and flag a monitor as **overdue** (amber dot + "overdue" chip)
  when its last check is older than twice its poll interval. The label ticks on
  its own every few seconds, so a long-interval monitor no longer shows a stale
  "up" for minutes after its endpoint has actually died — the staleness surfaces
  without waiting for the next poll. Addresses audit gap #11 (#1147).
