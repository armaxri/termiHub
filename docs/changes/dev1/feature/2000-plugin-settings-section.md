### Added

- Settings now has a **Plugins** category listing one group per installed plugin
  that declares `settings` in its manifest. Each group is rendered from the
  plugin's own settings schema by the shared dynamic-form machinery and tagged
  with a `plugin` badge; values load from and save to the plugin's stored
  configuration automatically, with an inline "Saved" acknowledgment and a
  recoverable error toast on failure. Plugins that declare no settings do not
  appear. The Plugin Manager's **Settings…** action now deep-links straight into
  this category and scrolls to the selected plugin (#2000).
