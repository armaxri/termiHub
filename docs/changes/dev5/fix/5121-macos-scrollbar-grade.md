### Fixed

- Turning horizontal scrolling on no longer leaves the terminal's last row under
  the horizontal scrollbar, and turning it off restores the full grid. Both
  could happen on macOS when the WebView applied the layout change a frame late
  (#5121).
