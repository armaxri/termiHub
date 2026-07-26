### Added

- Plugin Manager UI: a new **Plugins** entry in the Activity Bar (puzzle icon)
  opens a sidebar listing installed plugins — each a row with a state dot
  (green enabled / grey disabled / red error), a type icon, and version — with a
  search box and an **Install from file…** button. Selecting a plugin opens a
  detail panel in the main area showing its identity, extension points, requested
  permissions, and state-appropriate actions (Enable / Disable, Retry on error,
  Settings…, Uninstall). Installing from a `.termihub-plugin` file validates the
  package and shows a permission-review dialog before install. Uninstall warns
  when the plugin has active sessions, and a status-bar segment shows the
  installed / enabled plugin count. Builds on the plugin command surface (#1992)
  and frontend store (#1993).
