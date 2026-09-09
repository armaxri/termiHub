### Fixed

- Moving a terminal tab across panels (or into another tab group) no longer
  destroys that terminal's scrollback. The move is now committed to the layout
  region as a single settled-tree update instead of a pre-prune two-panel step
  followed by the merged one-panel result. The intermediate two-panel state
  briefly reflowed the terminal to a narrow width and back; the shell's resize
  prompt redraw at the narrow width overwrote the scrollback (visible on
  macOS/WKWebView, latent elsewhere). Cross-panel merges, edge splits, moves to
  an existing group, and moves to a brand-new group all apply their final
  geometry atomically now (#2712, #2705).
