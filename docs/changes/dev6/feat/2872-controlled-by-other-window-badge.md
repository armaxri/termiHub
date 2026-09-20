### Added

- Tabs now show a persistent "controlled by another window" badge when their
  session is owned by a different window in multi-window mode (resize is disabled
  in the non-owning window). The badge reads the existing session→window
  ownership mirror, hovering it explains the state, and clicking it brings the
  owning window to the foreground. Single-window users see no change. This
  complements the transient toast from SM-026, which only fired at the moment
  ownership changed (#2872).
