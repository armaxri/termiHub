### Changed

- Host monitoring: the host menu item now reads "Stop monitoring" instead of
  "Disconnect", and the stopped state reads "Monitoring off · Start monitoring".
  It only stops the readings; the session stays open (#5750).
- Host monitoring: local shell tabs no longer show CPU, memory, disk and network
  chips by default; turn on Settings ▸ External files ▸ Advanced ▸ Monitor local shells to see
  them. Remote sessions keep them. A local connection that turned monitoring on
  in its own settings keeps it (#5754).
- Host monitoring: the Swap chip is no longer shown by default. Choose the chips
  under Settings ▸ External files ▸ Advanced ▸ Status bar metrics; Swap is still available there
  (#5754).
