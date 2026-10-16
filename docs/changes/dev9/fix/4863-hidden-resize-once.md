### Fixed

- Resizing the window or dragging a splitter no longer resizes the terminals in background tabs
  twice. A background tab is now resized once, when you switch to it, so programs in it (vim, htop,
  less) redraw only once (#4863).
