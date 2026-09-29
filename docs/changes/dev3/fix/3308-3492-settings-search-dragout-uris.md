### Fixed

- Settings search now finds the update preferences ("update", "auto-check", "check now"). Updates
  also has its own Settings category, alongside the Updates dialog (#3308).
- Settings search now finds the External Files section (external connection files, Power
  Monitoring, File Browser) and the plugin Trusted Publishers section, which could be opened from
  the navigation but never matched a search (#3308).
- Dragging files out to a Linux file manager now sends percent-encoded `file://` URIs, so files
  whose names contain spaces, `%`, `#`, `?` or non-ASCII characters are no longer sent as invalid
  URIs (#3492).
