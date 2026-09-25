### Fixed

- When a layout change could not be applied (the backend rejected the split,
  tab open, tab close, or focus switch), the panel layout could quietly get out
  of sync with itself: the panel tree snapped back to how it was, but coupled
  state — a tab's stored content, the zoomed-tab overlay, and the per-tab
  settings maps — kept the change, leaving, for example, a leftover content
  entry for a tab that no longer existed or a zoom overlay pointing at a tab in
  a panel that was no longer focused. A rejected layout change is now
  all-or-nothing: both the structure and those coupled fields revert together,
  so the layout is left exactly as it was before the change. Successful layout
  changes are unaffected.
