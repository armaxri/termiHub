---
id: PKG-011
title: Linux ARM64 ships only .deb/.rpm — no portable AppImage (packaging parity gap)
angle: packaging-release
severity: low
category: packaging
is_workaround: true
subsystem: .github/workflows/release.yml
evidence:
  - .github/workflows/release.yml:134
  - .github/workflows/release.yml:139
status: open
---

## What
The Linux x64 target publishes `.AppImage` + `.deb`, but the Linux ARM64 target
publishes only `.deb` + `.rpm` (`extra_args: '--bundles deb,rpm'`). The workflow
comment explains why: `linuxdeploy` (the AppImage tool) is x86_64-only, so AppImage
cannot be produced on the native ARM64 runner. This is a documented tool limitation
worked around by dropping the format on ARM64.

## Why it matters
Raspberry Pi / ARM64 Linux users get no portable, distro-agnostic single-file build —
they must use `.deb` or `.rpm`, which excludes non-Debian/RPM distros and no-package
"just run it" usage that x64 users get. It is a real cross-platform parity gap, but
low severity: `.deb`/`.rpm` cover the dominant ARM64 Linux targets (Raspberry Pi OS,
Ubuntu, Fedora), and it is already documented.

## Evidence
- `release.yml:130-139` — ARM64 matrix entry with the "AppImage is not supported on
  ARM64 (linuxdeploy is x86_64-only)" comment and `--bundles deb,rpm`.
- `verify-release` (release.yml:487-495) correctly does **not** expect an
  `arm64.AppImage`, so the asset-set check is consistent with the gap.

## Recommendation
Track as a known ARM64 limitation for the beta and document it in the release notes
(x64 has AppImage; ARM64 uses deb/rpm). For a real fix later, evaluate an
ARM64-capable AppImage path (e.g. `appimagetool` with a manually assembled AppDir, or
running linuxdeploy under x86 emulation) so ARM64 reaches format parity with x64.
