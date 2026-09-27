### Added

- **Plugin index updates in the Plugins view.** **Check for updates** in the
  Plugins view (and the opt-in daily check) now also asks the plugin index. An
  installed plugin with a newer version in the index that works on this
  computer gets the update badge, and its detail panel shows "Update available
  (plugin index)" with **Download & install…**, which downloads and verifies
  the package and opens the regular install dialog. When a plugin's own update
  URL and the index both offer an update, the newer version wins; on a tie the
  plugin's own update URL is used (#3717).
