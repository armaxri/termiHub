### Fixed

- Editor tabs opened from a native Windows path (for example a saved terminal
  output file) are now titled with the file name instead of the whole path, and
  activating such a tab navigates the local file browser to the file's folder
  instead of trying to list the file itself. A top-level file such as `C:/x.txt`
  now resolves to the drive root `C:/` (#4372).

### Changed

- Quick Connect suggestions, the workspace connection picker and every
  searchable list (recent sessions, macros, workflows, keyboard shortcuts, icons,
  plugins, language packages) now match case- and diacritic-insensitively, like
  the sidebar connection search: `muller` finds `Müller` (#4372).
