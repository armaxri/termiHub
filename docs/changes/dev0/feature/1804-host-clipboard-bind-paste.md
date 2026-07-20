### Added

- RDP: files copied inside a remote RDP session can now be pasted into local
  apps via the host OS clipboard, with the bytes fetched from the remote only on
  the actual paste gesture (**delayed rendering**, not an eager download). The
  RemoteDesktop clipboard panel lists the files the remote copied and a **Copy to
  clipboard** button binds them onto the host OS clipboard; pasting into any app
  (e.g. Finder) then streams each file's bytes on demand into a sanitized,
  bounded staging file. **macOS** ships the native `NSPasteboard` binding; on
  every other platform the feature stays off and the existing eager shared-folder
  download (#1765) remains the behaviour, so nothing changes there. The
  `clipboard_delayed_render` gate is stamped from a host OS-capability check, not
  a connection setting, so it can only turn on where a real binding exists.
  Windows (`CF_HDROP` / `WM_RENDERFORMAT`) and Linux (X11/Wayland `text/uri-list`)
  bindings are tracked as follow-ups (#1804).
