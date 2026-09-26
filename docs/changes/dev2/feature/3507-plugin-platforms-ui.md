### Added

- The plugin install dialog and the plugin detail panel now list a native
  plugin's **Supported Platforms** by friendly name (macOS Apple Silicon/Intel,
  Windows x64/ARM64, Linux x64/ARM64; other target triples shown as-is) and mark
  **This computer**. Legacy single-platform packages show "Current platform only
  (legacy package)" (#3507).

### Changed

- Opening a multi-platform plugin package that does not support this computer
  now shows the install dialog with a clear "Not available for this computer"
  explanation and the list of platforms it does support, instead of an
  "Invalid plugin package" error toast. It still cannot be installed (#3507).
