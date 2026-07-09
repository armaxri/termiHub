### Added

- **SSH X11 / GUI forwarding** is now documented end to end for the X-server
  provisioning epic (#1047): `docs/testing.md` gains a consolidated
  **X11 / GUI forwarding** section with the per-platform release matrix (Windows
  auto-provision → forwarded `xeyes` → no-orphan shutdown; macOS XQuartz
  detect/guide + consent; Linux native, guide-only), and `docs/architecture.md`
  documents the X-server-provisioning subsystem plus **ADR-10** (bundle/download
  on Windows, guide on macOS/Linux). The `ssh-x11` Docker fixture adds a
  self-contained headless render check (in-container Xvfb) for CI-automatable
  forwarded-GUI verification (#1057).
