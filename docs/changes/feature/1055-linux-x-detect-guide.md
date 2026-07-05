### Added

- Linux SSH X11 forwarding: when no local X server can be reached, termiHub now
  surfaces a targeted, actionable hint instead of a generic failure — install
  `xwayland` on a Wayland session that lacks it, guidance for a headless system
  (graphical session / Xvfb), or the `--socket=x11` / `--socket=fallback-x11`
  grant when a Flatpak/Snap sandbox is hiding the host X socket. A normal
  graphical desktop is unaffected (#1055, epic #1047).
