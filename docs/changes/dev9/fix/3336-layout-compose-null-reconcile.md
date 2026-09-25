### Fixed

- Layout: the panel layout could freeze on a stale tree when the authoritative
  layout referenced a tab whose content the window did not hold (for example
  after a rejected tab close). The layout now reconciles instead: it follows the
  authoritative structure, drops tabs it cannot render, re-syncs the backend
  layout if the mismatch persists, and logs the dropped tabs to the Log Viewer
  (SM-024, #3336).
