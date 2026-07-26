### Added

- Theme plugins: an enabled plugin's bundled color themes (JSON-only, no code
  execution) now load into the theme engine and appear in the Appearance theme
  selector under a **Plugins** separator, each puzzle-badged, alongside the
  built-in and custom themes. Selecting one applies it like any other theme.
  Themes are validated against the full color-token schema, registered under a
  namespaced id, and — when a plugin theme's name collides with a built-in — the
  built-in wins and the plugin theme is shown prefixed with its plugin name.
  Disabling or uninstalling a theme plugin removes its themes, falling back to
  the default theme if one of them was active (#1996).
