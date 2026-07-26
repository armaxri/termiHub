### Added

- Plugin-provided terminal backends are now usable end-to-end as connection
  types. Once a native plugin (`terminalBackend` extension) is enabled, its
  connection type appears in the connection-type list the app offers, its
  manifest `configSchema` drives the connection form automatically (via the
  existing dynamic form — no bespoke UI), and creating a session of that type
  dispatches through the plugin for full terminal I/O (connect, write, resize,
  output, disconnect). Two plugins declaring the same connection-type name are
  disambiguated by suffixing the second with the plugin name (#1999).
