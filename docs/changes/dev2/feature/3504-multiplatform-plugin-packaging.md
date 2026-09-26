### Added

- One plugin package can now carry native libraries for several platforms; termiHub installs and
  loads only the library built for the machine it runs on, and binds native-plugin trust to that
  library (#3504).
- The plugin packager can build a plugin for specific targets (`--target`) and merge per-platform
  packages into one multi-platform package (`--merge`) (#3504).

### Changed

- Installing a multi-platform plugin package that has no library for your platform now fails
  with a clear "not available for this platform" message instead of failing later at load (#3504).
