---
id: WA-CI-027
title: Test-bridge scaffolding (CSP relaxation + TERMIHUB_TEST_FLAG_ injection) compiled into release
angle: workaround-ci-scripts
severity: low
category: workaround
is_workaround: true
subsystem: src-tauri/src/utils/test_bridge.rs
evidence:
  - src-tauri/src/utils/test_bridge.rs:36
  - src-tauri/src/utils/test_bridge.rs:184
  - src-tauri/src/lib.rs:1643
status: open
---

## What
The WebSocket test-bridge (issue #801) is compiled into the shipping desktop binary and
activated purely by env vars at runtime, not behind a `#[cfg(test)]`/debug-only gate:
- `TERMIHUB_TEST_BRIDGE_PORT` registers a Tauri plugin that injects globals into the webview.
- `relax_csp_if_test_bridge` (lib.rs:1643) **relaxes the app CSP** (adds `ws://127.0.0.1:*` /
  `ws://localhost:*` to `connect-src`) when the bridge env var is set.
- `TERMIHUB_TEST_FLAG_<NAME>` injects arbitrary `window.__TERMIHUB_<NAME>__` boolean globals to
  flip feature flags for a live run (#2476).
- `TERMIHUB_TEST_NO_ALWAYS_ON_TOP` and `macos_unthrottle` test hooks likewise.

All are gated by `is_test_bridge_enabled()` (env var present), so production with no env var is
inert and the CSP is byte-identical — verified by unit tests.

## Why it matters
This is test scaffolding shipped in the release artifact. It is well-guarded (env-gated,
name-sanitized against JS injection, CSP only widened, unit-tested to be inert by default), so
the risk is low — but the *capability* exists in every shipped binary: anyone who can set env
vars on the process can enable a WS bridge, relax the CSP, and flip internal feature flags. On a
safety-critical app that is a surface worth consciously deciding to ship.

## Evidence
`TEST_FLAG_ENV_PREFIX` (test_bridge.rs:36); `relax_csp_if_test_bridge` (test_bridge.rs:184,
called at lib.rs:1643); feature-flag injection (test_bridge.rs:54-60).

## Recommendation
Confirm this is an accepted release decision (it likely is, given the harness needs to drive
real release builds). To reduce surface, consider gating the bridge behind a build feature that
is off for GA release artifacts (on for the CI/nightly builds the harness drives), or require a
signed/opt-in token rather than a bare env var. At minimum, document it as an intentional shipped
capability. Low.
