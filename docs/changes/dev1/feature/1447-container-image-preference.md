### Added

- Shell-integration quick-access entries can now carry a saved **container
  image** and **mount-target** preference. When an entry opens a "new container"
  spawn and no explicit `--container-image` / `--container-mount` is given on the
  command line, the saved preference is used before the built-in defaults
  (`ubuntu:22.04` / `/workspace`). The fields are edited in the entry dialog
  (Settings → Shell Integration) and persist across restarts. Existing
  `settings.json` files without the fields are unaffected.
