### Fixed

- Accessibility: keyboard shortcuts can now be rebound without a mouse. Each
  binding in Settings → Keyboard Shortcuts is a focusable button that starts
  recording with Enter or Space; Escape cancels, Backspace or the Clear
  shortcut button clears, and a bare Tab leaves recording so focus is never
  trapped. Screen readers announce when recording starts, the resulting
  binding, and any conflict (#4330).
- Accessibility: the command palette, SSH key-path picker and quick-connect
  bar now tell screen readers which option is highlighted while you arrow
  through the list, and the key-path validation message is announced. The
  quick-connect suggestions can also be chosen with the arrow keys and Enter
  (#4330).
