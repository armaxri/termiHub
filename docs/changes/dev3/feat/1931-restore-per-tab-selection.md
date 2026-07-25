### Added

- Startup "Restore Previous Session?" dialog now supports **per-tab selection**:
  each stored tab has a checkbox, so you can restore a subset instead of the
  whole session. The confirm button relabels to "Restore N Selected" when a
  subset is chosen and is disabled when nothing is selected. Tabs whose
  connection target is unavailable are flagged with a warning icon and start
  unchecked — a serial device that is no longer connected shows "device
  offline", and an unreachable SSH/telnet host shows "host unreachable". The
  reachability check runs in the background after the dialog opens and never
  blocks restore (#1931).
