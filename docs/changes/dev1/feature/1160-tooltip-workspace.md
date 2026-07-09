## Changed

- The Workspace sidebar and Workspace editor icon buttons (New / Save Current /
  Export / Import; per-workspace Launch / Edit / Duplicate / Delete; and the
  layout designer's split, add-connection, add/remove group, remove-panel,
  remove-tab, reset-sizes, and size-badge controls) now use the shared
  accessible Tooltip for hover help — consistent, themed, and reachable on
  keyboard focus instead of mouse-only. Each converted button exposes its label
  as a proper accessible name (`aria-label`) instead of the browser `title`.
  Truncation/full-text hovers on workspace names and paths are unchanged (#1160).
