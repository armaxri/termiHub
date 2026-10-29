### Fixed

- SSH X11 forwarding on Linux and macOS now resolves the local X server at
  connect time the same way the X server setup dialog does. Before, the connect
  only looked for a server on TCP `:0` and otherwise logged a generic "no X
  server reachable … managed provisioning is unavailable" error: a Wayland-only
  Linux session never got the "install XWayland" guidance in the connect log or
  progress, and an installed-but-idle XQuartz was not started on connect
  (#4965).
