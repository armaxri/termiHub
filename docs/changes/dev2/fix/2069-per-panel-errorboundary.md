### Changed

- A render crash in one terminal panel no longer tears down every open session.
  Each split-view panel (and the zoom overlay) is now wrapped in its own error
  boundary that shows a localized fallback with a **Retry** button, so sibling
  panels and their live sessions keep running while the failed panel recovers in
  place. The app-wide boundary still catches anything outside the panels (#2069).
