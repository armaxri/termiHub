### Fixed

- Portable mode: the `{PORTABLE_DIR}` path placeholder is now resolved. A key path such as
  `{PORTABLE_DIR}/data/keys/id_rsa` (or `{PORTABLE_DIR}\data\keys\id_rsa` on Windows) points
  into the portable folder, so connections keep working when the drive letter or mount point
  changes. Previously the placeholder was passed through literally and the SSH connect failed.
  In installed mode the placeholder is left unchanged (#4571).
