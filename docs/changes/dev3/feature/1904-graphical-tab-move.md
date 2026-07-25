### Added

- Graphical (RDP/VNC) tabs can now be moved between native windows (#1904, epic
  #1899). Like terminal tabs, a remote-desktop tab moves **command-only** (the
  "Move to New Window" / "Move to Window ▸" menu — never drag), and the backend
  graphical session keeps running across the move — only the pixels are
  re-fetched, never the connection:
  - The destination window re-attaches to the still-live session instead of
    reconnecting, and shows a **"Reconnecting view…"** placeholder over the
    blank canvas until the first frame repaints, so there is no blank/stale
    flash.
  - A backend **request-full-frame-on-attach** hook
    (`remote_desktop_request_full_frame`) asks the session to re-emit a full
    framebuffer frame the moment the destination attaches, shortening the
    placeholder to a brief flash rather than waiting for the protocol's next
    natural keyframe.
  - The source window no longer tears down the RDP/VNC session when a moving tab
    unmounts; cursor/clipboard/cert-prompt state is rebuilt on the destination
    from the existing `remote-desktop-*` broadcast events.
