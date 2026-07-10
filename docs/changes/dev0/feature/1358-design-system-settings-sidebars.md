### Changed

- Design-system consistency: the Settings panels, the Services and Workspaces
  sidebars, and the file editor now compose the shared UI primitives (Button,
  Toggle, Select) instead of hand-rolled controls, so they match the rest of the
  app's look, hover, focus, and motion. The file editor's Save button now shows a
  pending/success state while writing (#1358).

### Fixed

- Accessibility: the show/hide password toggle is now reachable by keyboard
  (it was previously removed from the tab order), so keyboard-only users can
  reveal a typed password (#1358).
