### Fixed

- In horizontal-scroll mode the gap between the terminal's last row and the
  horizontal scrollbar is now the same on every platform. Where the system draws
  a wider scrollbar than the app asked for (macOS with a mouse, Windows), the
  terminal now measures the real scrollbar and reserves room for it, instead of
  leaving the bar almost touching the text (#5280).
