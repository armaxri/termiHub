### Added

- RDP: on **Windows**, files copied in a remote RDP session can now be pasted
  into any local app (Explorer, etc.) via the OS clipboard, with each file's
  bytes fetched from the remote only on the actual paste gesture rather than
  eagerly downloaded. The host advertises the delayed-render capability on
  Windows and binds the surfaced remote files to the clipboard as a delayed-render
  `CF_HDROP`, served on `WM_RENDERFORMAT` from a dedicated message-only owner
  window. This mirrors the macOS binding (#1804); other platforms keep the eager
  shared-folder download (#1765) as the fallback (#1814).
