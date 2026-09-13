---
id: PLG-011
title: No cross-platform / fat packaging; packer builds only the host OS; packaging not exercised in CI
angle: plugin-extensibility
severity: medium
category: tooling
is_workaround: false
subsystem: scripts/package-plugin.sh
evidence:
  - scripts/package-plugin.sh:87
  - docs/plugin-authoring.md:240
  - docs/plugin-authoring.md:244
status: open
---

## What
`package-plugin.sh` builds the backend `cdylib` for **the current OS only**
(`cargo build --release` → stage `lib*.{so,dylib}`/`*.dll` for `uname`), and the
docs confirm "A package's `backend/` directory carries the library for **one
operating system** only … Cross-platform builds are the author's responsibility;
ship one package per OS, or a fat package containing each platform's library."
But the tooling cannot *produce* that fat package — there is no cross-compile path —
and the docs admit "cross-platform dynamic-library building is not wired into per-PR
CI," so the packaging tool itself is exercised on a single platform only.

## Why it matters
- **Time-to-first cross-platform plugin is high.** An author who wants their plugin
  to work on Windows, macOS and Linux must run the packager on three separate
  machines and hand-assemble a fat package (or publish three downloads), with no
  tool support. Meanwhile the loader `find_backend_library` happily picks the
  current OS's library from a fat `backend/`, so the *runtime* supports fat packages
  the *tooling* can't build.
- **The packaging path is under-tested.** Because CI doesn't build cdylibs
  cross-platform or round-trip a real native package on each OS, a regression in the
  packer or the loader's platform selection can ship silently (the same
  "dark lane" pattern the repo has been bitten by elsewhere).

## Evidence
- `scripts/package-plugin.sh:87-127` — single-OS build + stage; the `case $(uname)`
  picks exactly one artifact name.
- `docs/plugin-authoring.md:240-247` — "one operating system only … ship one package
  per OS, or a fat package"; "not wired into per-PR CI".
- `core/src/plugin/host.rs:231-243` — `find_backend_library` selects by
  `DLL_EXTENSION`, i.e. it *supports* a fat `backend/` the packer can't create.

## Recommendation
Either provide a cross-compile/fat-package mode in the packaging tool (accept
prebuilt libraries for multiple targets and stage them all under `backend/`), or
document a concrete multi-machine workflow. Add a CI job that, on each platform,
builds the `echo-backend` example into a real `.termihub-plugin` and loads it
through `PluginHost` end-to-end, so the packaging + platform-selection path is
covered before release.
