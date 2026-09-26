### Fixed

- Windows local builds: `scripts\build.cmd` now builds and bundles the RDP helper
  (`termihub-rdp-helper.exe`), so a locally built Windows installer supports RDP
  like the release and dev-build installers.
- Windows agent builds: `scripts\build-agents.cmd` now writes the `.sha256`
  checksum sidecar next to every agent it builds (failing the build if it cannot)
  and accepts the same `--targets`, `--dev`, `--features`, `--sign-key` and
  `--sequential` options as `build-agents.sh`.
