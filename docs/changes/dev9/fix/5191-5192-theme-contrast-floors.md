### Fixed

- Every terminal ANSI colour, normal and bright, now reaches 3:1 contrast against the
  terminal background in all built-in themes. Bright/bold white in the Light theme and
  Solarized Light, and bright black in Solarized Dark, used to be the background colour
  itself and printed invisibly. Failing colours were nudged in lightness only, so each
  keeps its hue. Custom, imported and plugin themes get the same 3:1 floor when the
  terminal renders.
- Inactive activity-bar icons now reach 3:1 contrast against the activity bar in the
  Dark, Solarized Dark and Solarized Light themes.
