### Added

- RDP on **Linux**: files copied in a remote session can now be pasted into a
  local file manager (Files/Nautilus, Nemo, Caja, Dolphin) via the host **X11
  `CLIPBOARD` selection**, with the bytes fetched only on the paste gesture
  (delayed rendering) — the Linux sibling of the macOS binding (#1804). The app
  owns the selection and serves `text/uri-list` plus the
  `x-special/gnome-copied-files` / `x-special/mate-copied-files` variants, staging
  each file to a sanitized, bounded temp file only when a paste converts the
  selection, so no bytes move on copy. Under Wayland this works for the many apps
  XWayland bridges to the X11 clipboard; a native-only Wayland (`wlr-data-control`)
  data source is a follow-up. Advertised via the host `clipboard_delayed_render`
  capability on Linux; the eager shared-folder download (#1765) stays the fallback
  everywhere the binding is inactive. (#1815, follow-up to #1804)
