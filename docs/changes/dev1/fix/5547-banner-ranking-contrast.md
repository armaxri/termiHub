### Changed

- The bottom of the window now shows at most one notice at a time. A crash notice always
  comes first; the "Open in termiHub" file-manager offer waits until it is closed instead of
  stacking above it, and several agent crash notices appear one after another.
- Crash notices offer two actions, View report and Close. Exporting diagnostics lives in the
  report view, where you can see what would be exported, and "Don't show again" is a small
  link next to the explanation.
- Banner buttons no longer compete with the main button of the view: the file-manager offer's
  Install now and the crash notice's View report use the regular (not filled) button style.

### Fixed

- The crash notice's explanation and its secondary buttons, and the file-manager offer's, now
  meet WCAG AA contrast in every built-in theme. The crash notice uses a calm surface with an
  amber top border instead of a muddy warm grey.
- Toasts such as "Connected" now appear above a bottom banner instead of covering its buttons.
