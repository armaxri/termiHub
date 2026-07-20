### Added

- RDP: on **Linux**, paste **any local file** into the remote session, not just
  files staged in the shared folder. The sidecar now reads the host clipboard's
  `text/uri-list` selection on both **X11** (via `x11-clipboard`) and **Wayland**
  (via `wl-clipboard-rs`, with an X11 fallback for compositors without
  `wlr-data-control`), decodes the `file://` URIs to real paths, and offers those
  files to the remote over CLIPRDR — so a file copied in a Linux file manager can
  be pasted into the RDP session (#1792). This completes the host-clipboard file
  bridge across all three desktop platforms (macOS #1779, Windows #1791). As on
  the other platforms, the host clipboard takes precedence over the shared folder,
  files are served read-only from their real paths (regular files only,
  size-capped), the remote only ever selects an advertised index, it is gated
  behind the same opt-in as clipboard file transfer (#1778), and **view-only
  sessions never advertise or serve host-clipboard files.**
