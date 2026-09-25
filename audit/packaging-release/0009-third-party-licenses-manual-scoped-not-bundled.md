---
id: PKG-009
title: THIRD_PARTY_LICENSES is hand-maintained, scoped only to hosted X-server binaries, and not bundled into installers
angle: packaging-release
severity: low
category: docs
is_workaround: false
subsystem: THIRD_PARTY_LICENSES.md
evidence:
  - THIRD_PARTY_LICENSES.md:5
  - THIRD_PARTY_LICENSES.md:10
  - src-tauri/tauri.conf.json:52
status: open
---

## What
`THIRD_PARTY_LICENSES.md` is presented as "the canonical attribution surface
referenced from the in-app About → Open Source Licenses entry", but:
1. It is **manually maintained** and explicitly scoped to only *redistributed binary
   artifacts* (today just the X servers, e.g. VcXsrv); it deliberately excludes the
   hundreds of Rust crates and npm packages the app is built from ("covered by their
   own license metadata … not redistributed").
2. It is **not bundled** into the app or any installer — `tauri.conf.json` /
   `tauri.sidecar.conf.json` declare no `bundle.resources` entry for it, so the DMG /
   MSI / deb / AppImage do not contain the license text the About screen claims to
   reference. The file lives only in the repo.

## Why it matters
Whether an in-app "Open Source Licenses" screen can actually display attribution text
that is not shipped in the bundle is unclear — if it reads the repo file, that path
does not exist in an installed app. And relying on manual upkeep for the redistributed
X-server licenses (GPL/APSL obligations) means the attribution can silently drift from
what is actually downloaded/hosted. This is a compliance-hygiene gap, not a
functional blocker for a beta, but it should be correct before v1.0.

## Evidence
- `THIRD_PARTY_LICENSES.md:5-16` — scope note: only hosted binary artifacts; Rust/npm
  deps excluded.
- `THIRD_PARTY_LICENSES.md:24+` — hand-written VcXsrv (and other X-server) entries with
  a manually pinned version (`21.1.13`).
- `tauri.conf.json:52-62` / `tauri.sidecar.conf.json` — `bundle` has no `resources`
  entry, so the file is not packaged.

## Recommendation
Auto-generate the aggregate dependency attribution (e.g. `cargo about` / `cargo
bundle-licenses` for Rust, `license-checker` for npm) as part of the build, bundle the
generated file(s) as a `bundle.resources` entry, and have the About screen read the
bundled copy. Keep the hand-written redistributed-binary section (X servers) but wire a
check that its pinned versions match what the provisioning code actually downloads.
