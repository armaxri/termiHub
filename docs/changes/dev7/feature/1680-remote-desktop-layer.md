### Added

- Added a protocol-agnostic graphical remote-desktop session layer — a canvas
  tab with a hover toolbar (Ctrl+Alt+Del, clipboard, scaling, fullscreen,
  disconnect), connecting/reconnecting/view-only overlays, scale modes (Fit to
  Tab / 1:1 Pixel / Match Window), a bidirectional clipboard panel, and a
  shared session state machine. A built-in mock backend renders a moving test
  pattern so the feature works with no real server; VNC and RDP backends plug
  in behind it (#1680).
