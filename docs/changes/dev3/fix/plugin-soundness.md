### Security

- The plugin filesystem-scope guard now resolves symlinks before authorizing a
  path. Previously the check was purely lexical (`starts_with` after collapsing
  `..`), so a symlink *inside* a granted root that pointed outside it — e.g.
  `<root>/link -> /etc` — passed the check and the subsequent read/write followed
  the link out of the sandbox. The guard now canonicalizes the requested path's
  existing prefix and the declared roots, re-checks containment against the
  canonical roots, and returns the canonical path for the actual I/O; not-yet-
  existing write targets are resolved against their canonical parent, and dangling
  in-scope symlinks are refused (CORE-030 / SEC-003).

### Fixed

- Fixed a use-after-free on plugin session teardown. A plugin-backed connection
  held the loaded library `Arc` and the backend it created; the library was
  torn down before the backend, so the backend's FFI destructor could run against
  code that had already been unmapped (`dlclose`). The backend is now always
  destroyed while the library is still mapped (CORE-029).
