### Fixed

- Zooming a tab now repaints the terminal immediately at its new size. Content
  was often invisible until you scrolled up and down to force a rerender: when
  the terminal element is reparented into the zoom overlay, `fitAddon.fit()` is a
  no-op if the new container yields the same number of rows/columns, so the
  renderer kept showing stale/blank rows until a scroll marked them dirty. The
  fit path now forces a full viewport repaint after fitting, so zoomed content
  renders right away with no manual scroll (#1823).
