### Added

- **Debug symbols for every release**: each release now carries
  `termiHub-X.Y.Z-debug-symbols-*.tar.gz` assets (`.dSYM` / `.debug` / `.pdb`) for the
  desktop app, its RDP and plugin sidecars and every agent binary, kept out of the
  installers so they do not grow. Crash reports now record each frame's address plus the
  module's load address and build id, so a field crash report — including one from
  Windows, which previously showed bare addresses — can be symbolized to source file and
  line offline (Closes #4504).
