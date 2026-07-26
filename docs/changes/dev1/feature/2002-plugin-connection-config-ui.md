### Added

- Plugin connection types in the connection editor: a connection type provided
  by an active plugin now appears in the type selector below the built-ins under
  a puzzle-badged **Plugins** separator, so it is visually distinct from a
  built-in backend. Selecting one renders its configuration form from the
  plugin's manifest `configSchema` via the existing schema-driven form (no
  hardcoded fields), and saving produces a connection carrying the plugin's type
  id and the form's settings. Two plugins that register the same connection-type
  name are listed with distinct, disambiguated labels (#2002).
