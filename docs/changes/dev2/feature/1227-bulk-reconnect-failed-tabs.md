### Added

- The partial-restore summary toast ("Restored N of M tabs — K could not
  reconnect") now carries a **Reconnect failed tabs** action button. One tap
  re-drives every failed tab from that restore through the normal per-tab
  reconnect at once, instead of clicking into each tab and reconnecting it
  individually. The retry shows a pending toast that resolves into a fresh
  summary — success if all failed tabs come back, or another partial summary
  (with the retry button again) if some still fail. Addresses control M2 of the
  workspace save/restore audit (#1227).
