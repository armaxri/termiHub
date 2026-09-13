---
id: WA-RS-010
title: Test bridge, CSP relaxation and feature-flag override shipped in release binary
angle: workaround-rust
severity: low
category: security
is_workaround: true
subsystem: src-tauri/utils/test_bridge
evidence:
  - src-tauri/src/utils/test_bridge.rs:98
  - src-tauri/src/utils/test_bridge.rs:149
  - src-tauri/src/utils/test_bridge.rs:36
  - src-tauri/src/lib.rs:432
status: open
---

## What
The E2E test-bridge is compiled into the shipping binary and activates whenever
`TERMIHUB_TEST_BRIDGE_PORT` names a valid port. When active it:

- injects `window.__TERMIHUB_TEST_BRIDGE__` globals into the webview,
- **relaxes the Content-Security-Policy** (`relax_csp_if_test_bridge`),
- lets `TERMIHUB_TEST_FLAG_<NAME>=<bool>` env vars **override feature flags**
  at runtime (#2476),
- suppresses always-on-top via `TERMIHUB_TEST_NO_ALWAYS_ON_TOP` (#2504).

## Why it matters
A security-relevant capability (CSP relaxation + arbitrary feature-flag flipping
via env) exists in the release build, guarded only by an env var. Anyone able to
set env vars for the process can weaken the CSP and toggle unfinished features.
For a "ventilator-grade" release this is a surface worth removing from
production, not just leaving off by default.

## Recommendation
Compile the entire test-bridge module (bridge globals, CSP relaxation, flag
override) behind a Cargo feature (e.g. `test-bridge`) that is enabled only for
E2E builds and **off in the shipped installer**. Verify the release build has no
code path that reads `TERMIHUB_TEST_BRIDGE_PORT` / `TERMIHUB_TEST_FLAG_*`.
