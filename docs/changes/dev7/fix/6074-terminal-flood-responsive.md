### Fixed

- A terminal flooded with output (`yes`, `cat` of a huge file) no longer freezes the
  window on a slow machine: clicks, typing and Ctrl+C get through while it scrolls. The
  scrollbar was redrawn for every scrolled line, and each block of output was processed
  without a pause (#6074).
