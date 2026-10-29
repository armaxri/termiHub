### Fixed

- Full-screen terminal programs such as Claude Code are no longer cut off at the right edge
  of the pane (#5065). Two causes are fixed:
  - Moving the window to a monitor with a different scale, or changing the display scale,
    now re-fits every terminal. Before, the terminal kept the column count of the old
    scale. That could be more columns than the pane shows, and programs drew into the
    hidden ones.
  - Without GPU rendering (for example in a VM or a remote desktop session), text no longer
    runs past the pane's right edge. The app's text styling had switched off the spacing
    correction xterm.js uses to line glyphs up with their cells.
