### Fixed

- Cancel now works for plugin connections that are still connecting: it
  returns at once instead of waiting for the plugin, and the abandoned session
  is closed when the plugin answers. A slow plugin connect also no longer
  stalls other sessions while it waits (#4323).
