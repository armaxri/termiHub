### Fixed

- The connection editor's **Cancel** button no longer silently discards unsaved
  edits. It now routes through the same unsaved-changes confirmation as the
  Escape key and tab-close: clicking Cancel with a dirty form opens the
  "Unsaved changes" dialog, while a clean form closes immediately as before
  (UX-006).
