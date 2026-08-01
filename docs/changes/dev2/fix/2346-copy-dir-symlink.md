### Fixed

- Local file browser: copying a directory whose tree contains a symlink
  pointing at a directory no longer fails with a "source path is neither a
  regular file …" error that left a partial, half-copied result behind. Nested
  symlinks are now preserved as symlinks (pointing at their original target)
  instead of being followed (#2346).
