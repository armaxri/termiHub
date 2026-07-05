### Added

- Windows SSH X11 forwarding: tooling to build and publish the pinned, minimal
  VcXsrv `.zip` that termiHub downloads and SHA-256-verifies on first use.
  `scripts/internal/package-vcxsrv.ps1` repackages an installed VcXsrv into the
  redistributable artifact, prints its SHA-256, and can patch
  `PINNED_VCXSRV.sha256` directly. A networked release-verification test
  (`pinned_artifact_downloads_verifies_and_contains_exe`, `#[ignore]`) confirms
  the published artifact resolves and contains a runnable `vcxsrv.exe`. Once the
  artifact is published, first-run VcXsrv provisioning downloads, verifies, and
  extracts it automatically; offline re-runs reuse the cached tree (#1076,
  epic #1047).
