### Added

- Remote desktop (VNC/RDP): the keyboard release chord (default Ctrl+Alt+Shift) can now be
  rebound in Settings → Keyboard Shortcuts → Remote Desktop. The recorder captures
  modifier-only chords and requires at least two modifiers; the chord cannot be cleared, and
  an unusable stored value falls back to the default, so the remote-desktop view can never
  trap the keyboard. The canvas, its on-focus hint, the toolbar and the screen-reader
  description all show the bound chord, and the shortcuts overlay now lists it (#4524).
