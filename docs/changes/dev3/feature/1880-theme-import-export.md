### Added

- Appearance: import and export custom themes as `.json` files. New **Export**
  and **Import** actions in Appearance settings let you save the selected custom
  theme to a file and load a theme file back in. Imported themes are validated,
  get a `(2)` suffix if their name collides with an existing one, and become the
  active theme; missing or invalid color values fall back to the base theme's
  defaults with a heads-up, and unreadable or malformed files surface a clear
  error instead of failing silently (#1880).
