### Added

- Status bar: while a graphical remote-desktop tab (VNC/RDP) is active, the
  status bar now shows a live `monitor host:port · WxH · N-bit` segment — the
  host and port and colour depth come from the connection config, and the `WxH`
  resolution tracks the live framebuffer. The segment disappears when a
  non-graphical tab is focused. The active session's framebuffer resolution is
  now surfaced to the app store (keyed by session id) so shared chrome can read
  it (#1709, follow-up to #1680).
