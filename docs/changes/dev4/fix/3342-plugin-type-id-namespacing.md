### Fixed

- Plugins: a plugin's connection type is now registered under the stable id
  `plugin:<plugin id>:<connectionType>` instead of an id that depended on which
  plugins loaded first. Previously two plugins declaring the same connection
  type (or a plugin colliding with a built-in) got the bare name or a
  `-<plugin id>` suffix depending on load order, so saved connections could
  silently bind to the wrong plugin or stop resolving. Existing saved
  connections, session history and workspaces are migrated automatically on
  load; a connection whose plugin is not installed is kept and works again once
  the plugin is reinstalled. `connections.json` moves to schema version 3
  (#3342).

### Changed

- Plugin manifests: `terminalBackend.connectionType` must now be 1–64
  characters of letters, digits, `.`, `_` or `-` (#3342).
