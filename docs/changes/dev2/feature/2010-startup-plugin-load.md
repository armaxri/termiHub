### Fixed

- Plugins that were enabled in a previous session are now loaded automatically at
  startup, so a plugin-provided connection type is registered (and a persisted
  connection of that type resolves) without the user toggling the plugin off and
  on. A plugin that fails to load at startup is surfaced as `Error` and skipped
  rather than aborting startup (#2010).
