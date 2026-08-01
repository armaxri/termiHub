### Fixed

- Portable mode: a stray regular file named `data` (or a directory that merely
  happened to be named `portable.marker`) next to the executable no longer
  false-triggers portable mode. Previously such an entry flipped the app into
  portable mode and then crashed it at startup, because setup tries to create
  the portable `data/` directory over the non-directory path. Detection now
  requires an actual `data/` directory or a `portable.marker` file (#2357).
