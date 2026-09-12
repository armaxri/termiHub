---
id: MOCK-002
title: TestBridge remote-control hook + test_sever_agent_transport command ship in production, runtime-enableable via localStorage/URL
angle: test-mocking
severity: high
category: workaround
is_workaround: true
subsystem: src/testbridge, src-tauri/src/commands/agent
evidence:
  - src/components/Terminal/TerminalView.tsx:443
  - src/testbridge/testMode.ts:34
  - src/testbridge/TestBridge.tsx:136
  - src-tauri/src/lib.rs:1480
  - src-tauri/src/commands/agent.rs:127
status: open
---

## What
The in-app **TestBridge** — a harness surface that installs `window.__termihubTestBridge` and
exposes verbs to read terminal buffers, send input to terminals, drive window resize,
screenshot the DOM, emit backend Tauri events, and dispatch projection commands — is mounted
**unconditionally** in the production component tree (`<TestBridge />` in
`TerminalView.tsx:443`). It is inert only because its effect early-returns unless
`isTestBridgeEnabled()` is true.

`isTestBridgeEnabled()` returns true on **any** of four signals, and only the first is
build-gated:

```
# src/testbridge/testMode.ts:34
VITE_TEST_BRIDGE === "1"            // build flag (dev/test only) — OK
|| window.__TERMIHUB_TEST_BRIDGE__  // runtime global
|| ?testBridge=1                    // URL query param
|| localStorage["termihub.testBridge"] === "1"   // persisted, runtime
```

The last three work in a **shipped production build with no rebuild**. Anything that can set
a localStorage key or navigate the WebView with a query string flips the whole remote-control
bridge on. The backend half is likewise compiled in and registered in the default IPC command
list: `commands::agent::test_sever_agent_transport` (`src-tauri/src/lib.rs:1480`), which
abruptly severs an agent's transport.

## Why it matters
- This is a test double / test hook leaking into the release binary as **runtime-activatable
  attack surface**, not just dead code. Once enabled, `window.__termihubTestBridge.dispatch`
  can read terminal contents (potentially secrets on screen), inject keystrokes into live
  terminals, resize the window, rasterize the DOM, and emit arbitrary backend events. With a
  `?testBridgePort=<n>` it will also open an **outbound WebSocket to 127.0.0.1:<n>** and
  accept commands from whatever is listening (`TestBridge.tsx:148-163`).
- The code comment asserts "never production by default," but that guarantee holds only for
  the `VITE_TEST_BRIDGE` build flag; the localStorage/URL/global paths are not build-gated, so
  the guarantee does not actually hold for a released binary.
- Two verbs (`emitEvent`, `severAgentTransport`) re-check the gate, and the sever command is
  gated backend-side too — but the DOM-level verbs (`readTerminal`, `sendTerminalInput`,
  `getState`, `screenshot`) do **not** re-check; they run for as long as the bridge is
  installed. The bridge install itself is the only gate for those.

## Evidence
- Unconditional mount: `src/components/Terminal/TerminalView.tsx:443`.
- Runtime signals incl. localStorage/URL: `src/testbridge/testMode.ts:34-45`.
- Verb surface installed on `window`: `src/testbridge/TestBridge.tsx:70-140`.
- Outbound loopback WS driven by user-controllable `?testBridgePort`: `testMode.ts:56-64`,
  `TestBridge.tsx:148-163`.
- Test hook registered in the default command handler: `src-tauri/src/lib.rs:1480`; gate at
  `src-tauri/src/commands/agent.rs:149`.

## Recommendation
Compile the bridge out of production entirely: wrap the `<TestBridge />` mount, the
`testbridge/` module, and the `test_sever_agent_transport` command registration in a
build-time flag (`#[cfg(feature = "test-bridge")]` on the Rust side; `import.meta.env`-gated
dynamic import / dead-code-eliminated branch on the TS side) so none of it exists in a release
build. Do **not** rely on a runtime `isTestBridgeEnabled()` check inside shipped code as the
security boundary — a runtime-flippable localStorage/URL signal is not a boundary. If a
release-build diagnostic surface is genuinely wanted, it must be a separate, explicitly-signed
opt-in, not the E2E harness hook.
