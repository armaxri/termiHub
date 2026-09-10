---
id: SEC-005
title: Test bridge and its CSP relaxation are compiled into release builds; frontend activatable via localStorage/query
angle: security
severity: medium
category: security
is_workaround: true
subsystem: src/testbridge, src-tauri/src/utils/test_bridge.rs
evidence:
  - src/testbridge/testMode.ts:34
  - src/testbridge/testMode.ts:43
  - src-tauri/src/utils/test_bridge.rs:137
  - src-tauri/src/utils/test_bridge.rs:184
status: open
---

## What

The WebSocket test bridge — an automation surface whose dispatcher can drive
arbitrary in-app UI actions/state — and its CSP-relaxation code are compiled into
the **production binary and bundle**, gated only at runtime. There are two gates
with different strength:

1. **Backend CSP relaxation + init-script injection** is gated by the env var
   `TERMIHUB_TEST_BRIDGE_PORT` (`test_bridge.rs:111`, `:184-191`,
   `relax_csp_policy` at `:137`). This gate is sound: unset → no relaxation, no
   injection.
2. **Frontend activation** (`isTestBridgeEnabled`, `testMode.ts:34-45`) is *broader*
   — it turns the bridge on for **any** of: build flag `VITE_TEST_BRIDGE`, the
   injected `window.__TERMIHUB_TEST_BRIDGE__` global, a `?testBridge=1` **URL query
   param**, or `localStorage["termihub.testBridge"] === "1"`:

```ts
// src/testbridge/testMode.ts:41-43
checkSignal(() => new URLSearchParams(window.location.search).get("testBridge") === "1") ||
checkSignal(() => window.localStorage?.getItem(TEST_BRIDGE_STORAGE_KEY) === "1")
```

So in a shipped build, the frontend bridge can be switched on via persisted
`localStorage` or a query string — without the env var — and will then attempt to
connect out to a WebSocket runner and expose the dispatcher.

## Why it matters

The two gates disagree, which is the risk. The dispatcher is an
automate-the-whole-app capability; shipping it in release and letting a
non-env-var signal (localStorage/query) flip it on widens the attack surface:

- Any code that can write `localStorage` on the app origin (a compromised
  dependency, an XSS — none found today, but defense-in-depth — or a
  future-injected page) can latch the bridge persistently.
- The outbound WebSocket is blocked in a stock release because the CSP is *not*
  relaxed without the env var, so end-to-end exploitation needs both gates today.
  But relying on "the other gate saves us" is fragile: any future change that
  relaxes `connect-src`, or an in-process-only dispatcher path, removes the
  safety. Dead automation code in a safety-critical release binary should not be
  reachable by client-controlled state at all.

Marked `is_workaround: true`: the compiled-in bridge + CSP-widening is a
test-affordance carried in the release artifact.

## Evidence

- `src/testbridge/testMode.ts:34-45` — activation includes URL query + localStorage.
- `src-tauri/src/utils/test_bridge.rs:137` — `TEST_BRIDGE_CSP_CONNECT_SRC` (`ws://…`)
  and `relax_csp_policy` compiled in; `:184` `relax_csp_if_test_bridge` env gate.
- `src-tauri/src/utils/test_bridge.rs:96-101` — init script sets bridge globals
  and a page-visibility override; injected only when the env var is set (good).

## Recommendation

Compile the test bridge out of release builds behind a Cargo feature / Vite build
condition (`#[cfg(feature = "test-bridge")]`, `if (import.meta.env.DEV)`), so the
dispatcher, ws client, and CSP-relaxation strings are simply absent from the
production artifact. If it must remain compiled in, make the frontend gate match
the backend: require the injected global (env-var-driven) only, and drop the URL
query and localStorage activation paths from production. Add a release assertion
(release-check.sh) that the shipped bundle contains no `ws://` CSP source and no
`termihub.testBridge` activation path.
