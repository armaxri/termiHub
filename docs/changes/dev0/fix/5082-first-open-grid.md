### Fixed

- A new terminal tab now opens at the size that fits its pane. Before, it could keep the
  measurements of the stand-in font shown while the terminal font loaded, so full-screen
  programs such as Claude Code laid out for the wrong size: lines ended short and the bottom
  rows were hidden until the window was resized (seen on Retina Macs). The terminal now
  measures the font again once it has loaded, and again whenever another font loads (#5082).
