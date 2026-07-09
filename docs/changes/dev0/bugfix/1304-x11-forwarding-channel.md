### Fixed

- SSH X11 forwarding: forwarded X11 apps (e.g. `xeyes`, `xclock`) now actually
  open their window. termiHub requested the remote X11 listener on a random
  ephemeral port and derived the display number from it, producing huge,
  non-standard values like `:26961` that stricter X clients refuse to connect
  to — so the forwarded connection was never made and no window appeared. The
  forward is now allocated on a conventional X11 display port (like OpenSSH's
  `X11DisplayOffset`, e.g. `:10`), which every X client accepts.
