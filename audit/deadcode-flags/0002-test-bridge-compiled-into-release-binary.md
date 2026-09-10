---
id: DEAD-002
title: WebSocket test-bridge is compiled into the release binary (env-gated, not cfg-gated)
angle: deadcode-flags
severity: medium
category: workaround
is_workaround: true
subsystem: src-tauri/src/utils/test_bridge.rs, src-tauri/src/lib.rs
evidence:
  - src-tauri/src/utils/mod.rs:20
  - src-tauri/src/utils/test_bridge.rs:1
  - src-tauri/src/lib.rs:394
  - src-tauri/src/lib.rs:1636
status: open
---

## What
The cross-platform WebSocket test bridge (#801) is compiled into every build,
including release. `src-tauri/src/utils/mod.rs:20` declares `pub mod test_bridge;`
with **no `#[cfg(…)]` gate**; the module is merely inert at runtime unless
`TERMIHUB_TEST_BRIDGE_PORT` is set. The same is true of the CSP-relaxation and
window-injection paths in `lib.rs` that call into it.

## Why it matters
Test automation machinery — a plugin that injects JS globals into the webview before
boot and a path that **widens the `connect-src` CSP** — ships in the production
binary. It stays dormant without the env var, but a "no scaffolding in release"
posture wants test-only code excluded from the shipped artifact by compilation, not
by a runtime env check, so the CSP-relaxation and JS-injection code physically cannot
run in a release build.

## Evidence
- `src-tauri/src/utils/mod.rs:20`: `pub mod test_bridge;` (unconditional)
- `src-tauri/src/utils/test_bridge.rs:14`: "only registered when the env var is
  present, so production builds inject nothing and the bridge stays inert" — inert,
  but present.
- `src-tauri/src/lib.rs:1636-1643`: `relax_csp_if_test_bridge(&mut … .security.csp)`
  compiled into release, no-op unless the env var is set.

## Recommendation
Gate the module and its call sites behind a dedicated cargo feature (e.g.
`test-bridge`) that is off by default and enabled only by the E2E/reconnect-grade
build. This keeps the CSP-relaxation and JS-injection code out of the release binary
entirely. Trade-off to confirm with the maintainer: the automated reconnect-grade
(`test_agent_reconnect_ui.py`) depends on the bridge, so the CI build that runs it
must pass `--features test-bridge`. If the maintainer prefers to keep it always-compiled
for grade simplicity, downgrade this to `info`, but the CSP-widening path is the reason
it is flagged `medium`.
