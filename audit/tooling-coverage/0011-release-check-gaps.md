---
id: TOOL-011
title: release-check.sh skips coverage, system tests, and the real bundle build
angle: tooling-coverage
severity: medium
category: tooling
is_workaround: false
subsystem: scripts / release
evidence:
  - scripts/release-check.sh:1
status: open
---

## What

`release-check.sh` is a solid readiness gate for **metadata and unit state** —
version consistency across 5 files, Tauri npm/crate drift, CHANGELOG dated section,
unconsolidated change fragments, unit tests (frontend + Rust), `check.sh`, clean git
tree, branch, and a TODO/FIXME/HACK scan. But for a release gate it has three
notable holes:

1. **No coverage check** — it never runs `pnpm test:coverage` or any Rust coverage,
   so a coverage regression cannot block a release.
2. **No system/integration tests** — it runs only `pnpm test` + `cargo test
   --workspace`, never the Python bridge harness or the Docker integration lane, so
   the release gate has the same dark-integration blind spot as per-PR CI (TOOL-005).
3. **No real bundle build / smoke test** — it never runs `pnpm tauri build` nor
   `smoke-test.sh`, so "READY for release" is declared without ever producing or
   launching the actual installable artifact.

The TODO/FIXME/HACK scan is `warn`-only (`WARNINGS`, non-blocking), so markers never
block a release even though the workaround mandate wants them gone.

## Why it matters

The script is named and used as *the* release readiness check, and it reports "READY
for release" while skipping the three things most likely to be broken at release time
(actual build, integration behavior, coverage). A green `release-check.sh` currently
over-promises.

## Evidence

`scripts/release-check.sh` sections in order: Version Consistency, Tauri drift,
CHANGELOG, stale [Unreleased], change fragments, Tests (`pnpm test` + `cargo test`),
Quality Checks (`check.sh`), git clean, branch, TODO/FIXME/HACK (warn only), summary.
No `test:coverage`, no `test-system-py.sh`, no `tauri build`, no `smoke-test.sh`.

## Recommendation

Extend `release-check.sh` with (gated behind a `--full`/`--fast` flag so the fast
metadata pass stays quick):

- a **coverage** step (the unified TOOL-001 command) that fails on a drop;
- the **system-test** machinery suite at minimum, and ideally a nightly-equivalent
  integration run;
- a **real `pnpm tauri build`** followed by `smoke-test.sh` against the built binary;
- decide deliberately whether unresolved `TODO/FIXME/HACK` should **fail** (blocking)
  rather than warn for a release build — per the workaround mandate they should.
