### Added

- Terminal settings: new **Screen Reader Mode** toggle (off by default). When
  enabled, terminals turn on xterm's screen-reader mode so assistive technology
  (VoiceOver, NVDA, JAWS, Narrator) can read terminal output. Applied to open
  terminals live and to newly opened ones (#2071).

### Changed

- Accessibility: the open-session tab strip is now an ARIA `tablist` — each tab
  is a `role="tab"` with `aria-selected`, so screen readers announce the active
  session, and keyboard focus roves across tabs with Arrow/Home/End keys (#2071).
- Accessibility: the connection-form field help popover now uses the shared
  Modal, gaining a focus trap, ESC-to-close, focus return to the trigger, and a
  proper accessible name (#2071).
- Accessibility: the terminal area now exposes an `aria-label`ed region for
  assistive technology (#2071).
