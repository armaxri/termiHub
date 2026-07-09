### Fixed

- Connection editor: the **Storage File** picker no longer crashes when it is
  shown. Its "Default (connections.json)" option used an empty-string value,
  which Radix Select forbids (the empty string is reserved for clearing the
  selection). The default option now uses a non-empty sentinel that maps back to
  the default storage file, so the picker renders correctly whenever external
  connection files are enabled (#1105).
