### Fixed

- The file browser of a WSL tab now shows where a symlink points. Windows could
  tell that an entry was a WSL symlink but could not read its target over the
  `\\wsl$` share, so every WSL link was listed without one. termiHub now reads
  the targets inside the distribution.
