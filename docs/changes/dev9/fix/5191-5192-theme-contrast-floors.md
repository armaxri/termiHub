### Fixed

- Terminal text now keeps at least 3:1 contrast against its own cell background in every
  theme, including custom, imported and plugin themes. Bright/bold white in the Light
  theme and Solarized Light, and bright black in Solarized Dark, used to print invisibly.
  The adjustment is made per cell when the terminal draws, and changes only the text
  colour: the ANSI palettes keep their canonical values, so ANSI-black backgrounds
  (powerline/Agnoster prompts, TUI panels) still blend into the terminal background.
- Inactive activity-bar icons now reach 3:1 contrast against the activity bar in the
  Dark, Solarized Dark and Solarized Light themes.
