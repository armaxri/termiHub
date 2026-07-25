### Fixed

- **Broadcast input** now resolves its target terminals within the **source
  tab's own tab group**, never the active group. Previously, with broadcast
  active, opening or switching tab groups could silently retarget input to a
  terminal in a different, possibly invisible group while the visible terminals
  received nothing. Membership is also refreshed when a tab is moved across
  groups. (#1980)
