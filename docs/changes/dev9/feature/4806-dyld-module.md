### Changed

- **macOS crash reports list dyld**: the `modules:` section now includes `/usr/lib/dyld`
  itself, so frames inside the dynamic loader can be attributed too (#4806).
