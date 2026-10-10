### Fixed

- The macOS DMG again shows the `Applications` shortcut for drag-to-install, with
  its volume icon. Re-signing the app for the unsigned beta used to rebuild the
  disk image from the bare app and drop them (#4361).

### Internal

- The Release workflow now creates the release as a draft and publishes it only
  after every asset and attestation verified. Every upload replaces an existing
  asset, so re-running a failed job finishes the release instead of failing on
  "already exists" (#4361).
