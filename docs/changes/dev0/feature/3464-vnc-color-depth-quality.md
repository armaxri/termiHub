### Added

- VNC connections have a **Color Depth** select in the editor's Display group:
  _32-bit (true color)_, the default and previous behavior, or _16-bit (high
  color)_, which halves the framebuffer bandwidth. The status bar shows the
  depth of VNC tabs again (#3464).
- VNC connections have a **Quality** select under VNC Options: _Lossless (no
  JPEG)_, the default and previous behavior, or _High_ / _Medium_ / _Low_, which
  let Tight-capable servers send lossy JPEG at decreasing quality and increasing
  compression to save bandwidth on photo-like content (#3464).

### Fixed

- Server-pushed cursor shapes now render in every true-color pixel format
  instead of being dropped outside 32-bit color (#3464).
