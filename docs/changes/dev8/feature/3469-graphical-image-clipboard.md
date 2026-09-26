### Added

- Remote desktop (RDP): clipboard images now work in both directions. When the
  remote copies a picture or screenshot, the clipboard panel shows its size and
  **Copy image** puts it on your local clipboard; **Send local image** pushes the
  image on your local clipboard to the remote session. Images larger than
  8192 px per side or 32 MiB of pixel data are refused rather than scaled, the
  send action is hidden in view-only sessions, and only the window that controls
  the session can read or send images (PROD-021).

### Fixed

- Remote desktop (VNC): accented clipboard text (e.g. `café`) no longer turns
  into replacement characters. Server clipboard text is decoded as UTF-8 when
  valid and as Latin-1 (the RFB standard) otherwise, local text is sent as
  Latin-1 when possible, and an oversized server clipboard payload is skipped
  instead of being buffered in memory. VNC's standard clipboard remains
  text-only (PROD-021).
