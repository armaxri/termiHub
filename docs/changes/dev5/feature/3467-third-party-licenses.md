### Added

- **About → Third-Party Licenses** now opens an in-app viewer with the full license
  notices of every open-source Rust crate and npm package bundled in termiHub, instead of
  a GitHub page. The notices are generated from the real dependency graph at release
  time, bundled with every installer, and attached to each release as
  `termiHub-<version>-THIRD_PARTY_NOTICES.txt` next to the agent binaries (PKG-009,
  #3467).
