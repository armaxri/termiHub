---
id: DOC2-007
title: "Version-bump procedure omits three shipped crates (plugin-runner, plugin-api, rdp-sidecar)"
angle: docs-accuracy
severity: low
category: stale-procedure
is_workaround: false
subsystem: "docs/contributing.md / release"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: previous-incomplete
previous_id: DOC-012
evidence:
  - docs/contributing.md:1330-1339
  - docs/contributing.md:1403-1405
  - scripts/release-check.sh:244-269
  - plugin-runner/Cargo.toml:3
  - plugin-api/Cargo.toml:7
  - rdp-sidecar/Cargo.toml:3
  - plugin-runner/src/runner/mod.rs:127
  - src-tauri/tauri.sidecar.conf.json:4
---

## What

DOC-012's fix lists five version files: package.json, src-tauri, tauri.conf, agent and core. release-check.sh checks only those five. Since then plugin-runner, plugin-api and rdp-sidecar have been added. They carry their own `version = "0.1.0"`, ship in every installer (tauri.sidecar.conf.json externalBin) or as the plugin ABI crate, and surface their version at runtime (the runner reports CARGO_PKG_VERSION in its Hello) and in the release SBOMs. Following the documented procedure for 0.1.1 would leave these three at 0.1.0.

## Why it matters

A release would ship binaries and SBOMs that report inconsistent component versions. That weakens provenance and confuses diagnostics such as runner version reports. The fix for the earlier finding no longer covers all shipped crates.

## Recommendation

Either add the three manifests to the version-bump list, the commit command and release-check.sh's consistency check, or move them to `version.workspace = true` where possible and state in the docs that these crates are versioned independently on purpose.

## Verification

Confirmed. contributing.md lists 'all five locations', and release-check.sh lines 244-269 check only those five. plugin-runner, plugin-api and rdp-sidecar each set version = "0.1.0" independently and are not covered.
