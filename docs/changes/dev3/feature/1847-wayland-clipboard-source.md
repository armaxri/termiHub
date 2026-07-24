### Added

- RDP on **Linux/Wayland**: files copied in a remote session can now be pasted
  into **native-only Wayland** file managers (ones that read solely over
  `wlr-data-control` and never go through XWayland, e.g. GNOME Files under a pure
  Wayland session), completing the Linux host-clipboard binding (#1815). On a
  Wayland session the app now owns a native `wlr-data-control` **data source** that
  serves `text/uri-list` plus the `x-special/gnome-copied-files` /
  `x-special/mate-copied-files` variants on its `send` callback, fetching each
  file's bytes only on the paste gesture (delayed rendering) — the same no-bytes-on-
  copy contract as the X11 owner. The owner is chosen at runtime: a Wayland session
  binds the native source (and still binds the #1815 X11 `CLIPBOARD` owner when
  XWayland is present, so XWayland-bridged apps keep working); a pure X11 session
  binds only the X11 owner; a compositor without `wlr-data-control` degrades
  cleanly to the X11/XWayland path. (#1847, follow-up to #1815)
