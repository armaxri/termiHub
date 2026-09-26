### Changed

- Plugins: the native plugin ABI is now frozen at version 1.0 with major/minor
  compatibility. A native plugin keeps loading across termiHub updates within the same
  major version, and a plugin built for a newer version is refused with a clear message
  naming both versions and telling you to update termiHub (#3367).
- Plugins: a plugin's manifest `apiVersion` must now be written as `major.minor` (for
  example `"1.0"`) and, for native plugins, match the ABI version of the bundled library;
  mismatched packages are refused. Native plugins built before 1.0 must be rebuilt
  (#3367).
