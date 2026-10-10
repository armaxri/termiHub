### Fixed

- Update checker: a release is now treated as a security update (no "Skip this version")
  only when the release pipeline's `<!-- security -->` marker sits at the start of the
  release notes or alone on its own line. Release notes that merely quote the marker in
  prose, such as the changelog entry describing the update checker, no longer make an
  ordinary release unskippable, and the release pipeline still adds the marker to genuine
  security releases whose notes quote it (#4389).
