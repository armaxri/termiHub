### Added

- Import and export macros as portable JSON files, so macros can be shared
  between machines and users. The Macro Manager panel gains an **Export All**
  and an **Import** toolbar button, and each macro row gains an **Export**
  action for exporting a single macro. Exports use a small, explicit, versioned
  envelope (`{ version, macros: [...] }`) rather than the raw internal store, so
  the format is stable. On import, files are validated (a malformed or
  incompatible file fails with a clear, recoverable toast and never touches the
  existing library), imported macros are assigned fresh ids, and any name that
  collides with an existing macro is de-duplicated with an "(imported)" suffix.
  (#1677, epic #1670)
