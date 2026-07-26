### Added

- Plugin packaging tooling and reference material (#1994): a `package-plugin`
  script (`.sh` + `.cmd`) turns a plugin source directory into a validated
  `<id>-<version>.termihub-plugin` archive — building the backend `cdylib` when
  the source is a Rust crate, staging it into `backend/`, zipping the package
  layout, and round-trip validating the result. Two worked example plugins ship
  under `examples/plugins/`: `solarized-night-theme` (JSON-only theme plugin) and
  `echo-backend` (a native terminal-backend crate built against
  `termihub-plugin-api`). A new `docs/plugin-authoring.md` documents the package
  format, manifest schema, permissions, extension points, and the native-backend
  ABI caveat.
