---
id: DOC-013
title: docs/release-plan-0.1.0.md is stale — references the retired tauri-driver full E2E suite and a superseded release approach
angle: docs-accuracy
severity: low
category: docs
is_workaround: false
subsystem: docs/release-plan
evidence:
  - docs/release-plan-0.1.0.md:29
  - docs/testing.md:1011
status: open
---

## What

`docs/release-plan-0.1.0.md` (dated 2026-03-08) assigns machines to run the "Full E2E suite
(tauri-driver)". The WebdriverIO/`tauri-driver` full E2E suite was fully retired (#1027) — per
`docs/testing.md`, all specs were ported to the Python bridge harness and `tauri-driver` now backs
only the smoke test. The release plan also predates the current turnkey release strategy (the plan's
multi-phase 18–24 h manual estimate has been overtaken by the automated harness + a small number of
device sessions). So the plan describes a test topology and process that no longer exist.

## Why it matters

If a releaser opens the versioned release plan expecting it to be authoritative, they'll try to run
a retired E2E suite and follow a superseded phase plan. Low severity because the operative release
process now lives in `docs/contributing.md` (Release Process) and the release-strategy notes, but a
stale, official-looking `release-plan-0.1.0.md` in the tree invites confusion at exactly the wrong
moment.

## Evidence

- `docs/release-plan-0.1.0.md:29` — Environment table: "WSL on Windows … **Full E2E suite
  (tauri-driver)**"; other rows reference tauri-driver-era testing.
- `docs/testing.md:1011` — "all WebdriverIO specs have been ported to the cross-platform Python
  bridge harness … and the wdio harness has been fully retired … removed in #1027." Only
  `scripts/smoke-test.sh` still uses `tauri-driver`.

## Recommendation

Add a header banner marking `release-plan-0.1.0.md` as historical/superseded (pointing to
contributing.md's Release Process and the current release strategy), or refresh it to reference the
Python bridge harness instead of the retired tauri-driver E2E suite.
