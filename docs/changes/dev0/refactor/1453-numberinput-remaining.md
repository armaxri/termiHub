### Changed

- More numeric form fields now share one blank-value behavior: clearing a
  numeric input leaves it blank instead of silently snapping back to a default.
  This covers the embedded-server port (a blank port now blocks Save), the
  global Terminal scrollback buffer and Appearance font-size/line-height, the
  per-connection font-size/scrollback overrides, the agent persistent-buffer
  size, and the workspace panel-size editor. Valid values still save exactly as
  before (#1453).
