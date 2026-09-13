---
id: PKG-001
title: Full test-bridge (CSP relaxation + JS injection + diagnostic routes) is compiled into the release binary, gated only by an env var
angle: packaging-release
severity: high
category: security
is_workaround: true
subsystem: src-tauri/src/utils/test_bridge.rs
evidence:
  - src-tauri/src/utils/test_bridge.rs:110
  - src-tauri/src/utils/test_bridge.rs:125
  - src-tauri/src/utils/test_bridge.rs:184
  - src-tauri/src/lib.rs:394
  - src-tauri/src/lib.rs:1643
status: open
---

## What
The WebSocket test-bridge subsystem — which injects arbitrary JS globals into the
webview before page load, **relaxes the production CSP** (`connect-src` widened to
`ws://127.0.0.1:* ws://localhost:*`), overrides the Page Visibility API, keeps the
window always-on-top, and adds diagnostic (`diag.*`) command routes — is **compiled
into the release build**. Nothing gates it out at compile time: there is no
`#[cfg(debug_assertions)]`, no `#[cfg(feature = ...)]`, no `#[cfg(test)]`. The only
gate is the runtime environment variable `TERMIHUB_TEST_BRIDGE_PORT` (plus
`TERMIHUB_TEST_FLAG_*` and `TERMIHUB_TEST_NO_ALWAYS_ON_TOP`).

The module docstring even asserts "production builds inject nothing and the bridge
stays inert" — which is true only so long as the env var is unset, not because the
code is absent.

## Why it matters
The shipped v0.1.0 binary contains a live automation/instrumentation channel that,
when activated by an environment variable, weakens the app's CSP and opens a JS
injection + command surface. Any process that can influence the app's environment at
launch (a malicious launcher, a compromised parent process, a poisoned `.desktop`
file / shortcut, a shared CI/kiosk environment) can turn the running production app
into a remotely-driveable instance and downgrade its web-security posture. For a
"ventilator-grade" security bar this is exactly the kind of dev-only scaffolding that
should not exist in a release artifact. Multiple audit angles flagged the test-bridge
shipping in the default build.

## Evidence
- `test_bridge_plugin()` (test_bridge.rs:110) registers the JS-injection plugin
  whenever `parse_port(env TERMIHUB_TEST_BRIDGE_PORT)` succeeds.
- `relax_csp_if_test_bridge()` (test_bridge.rs:184) rewrites the CSP at runtime; it is
  called unconditionally from `lib.rs:1643` and only no-ops on the env check.
- `lib.rs:394-398` registers the bridge plugin in the normal app setup path.
- Gating is purely `std::env::var(TEST_BRIDGE_PORT_ENV)` (test_bridge.rs:125) — no
  build-time exclusion.

## Recommendation
Compile the bridge out of release artifacts entirely. Put the whole
`utils::test_bridge` module and all its call sites behind a dedicated cargo feature
(e.g. `test-bridge`) that is **off in `default`** and enabled only by the
system-test/dev-build workflows (`--features test-bridge`). Then `#[cfg(feature =
"test-bridge")]`-gate `test_bridge_plugin`, `relax_csp_if_test_bridge`, the
diagnostic-route registration in `lib.rs`, and the always-on-top / visibility hooks,
with no-op stubs when the feature is off. This makes the "production output is
byte-identical" claim structurally true (the code is absent) rather than dependent on
an env var. The release pipeline (release.yml) must build without the feature; the
system-integration lane builds with it.
