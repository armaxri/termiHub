---
id: TIN-003
title: Full test-bridge dispatcher is compiled into the production bundle and runtime-activatable
angle: test-integration
severity: medium
category: security
is_workaround: false
subsystem: src/testbridge
evidence:
  - src/components/Terminal/TerminalView.tsx
  - src/components/FileEditor/FileEditor.tsx
  - src/testbridge/testMode.ts:34
  - src/testbridge/dispatcher.ts:362
  - src-tauri/tauri.test.conf.json:6
status: open
---

## What

The in-app test bridge is **statically imported** by shipping components
(`TerminalView.tsx`, `FileEditor.tsx` both `import { TestBridge }`), so the whole
dispatcher — a verb set that can click/type/drag anywhere, read terminal
buffers, emit backend events, sever an agent transport, and dispatch projection
intents (`dispatcher.ts:362-830`) — is compiled into the **production** bundle,
not tree-shaken out. It is dormant only by a runtime guard,
`isTestBridgeEnabled()`, which returns true on **any** of: build flag
`VITE_TEST_BRIDGE=1`, `?testBridge=1` in the URL, `localStorage["termihub.testBridge"]==="1"`,
or a `window.__TERMIHUB_TEST_BRIDGE__` global (`testMode.ts:34-52`).

So a release build carries the entire automation surface and will install
`window.__termihubTestBridge` if any of those runtime signals is set — three of
the four are **not** build-time.

## Why it matters

- **Test surface leaks into the shipped product.** For a safety-critical app the
  automation harness that can drive the whole UI and sever live connections
  should not be reachable in a customer build at all. Even if the outbound
  WebSocket client cannot connect under the production CSP (see TIN-004), the
  in-process `window.__termihubTestBridge` dispatch object is still installed and
  callable by any script with page context.
- **Defence-in-depth is partial.** `severAgentTransport` is doubly gated (the
  backend `test_sever_agent_transport` command also refuses unless
  `TERMIHUB_TEST_BRIDGE_PORT` is set — `docs/test-bridge.md:381-385`), which is
  good, but the *rest* of the dispatcher (click/type/drag/getState/emitEvent/
  projectionDispatch) has no such backend gate — it operates purely in the
  renderer.
- This is the concern the security angle flagged; captured here from the
  test-integration side because the root cause is that the **test** code is not
  excluded from release by construction, only by a runtime flag.

## Evidence

- `grep TestBridge src --include=*.tsx | grep -v testbridge/` →
  `TerminalView.tsx`, `FileEditor.tsx` (static imports, not `React.lazy`).
- `testMode.ts:34-52` — four opt-in signals, three runtime.
- `dispatcher.ts` verb catalog: `click`, `type`, `drag`, `contextMenu`,
  `pressKey`, `readTerminal`, `getState`, `emitEvent`, `severAgentTransport`,
  `projectionDispatch`, … (lines 362-830).

## Recommendation

- **Exclude the bridge from production by build, not by runtime flag.** Gate the
  import behind `import.meta.env.VITE_TEST_BRIDGE` and lazy-load
  (`if (import.meta.env.VITE_TEST_BRIDGE) import('./testbridge/TestBridge')`) so a
  release bundle contains no dispatcher code at all — the runtime signals then
  cannot resurrect a surface that isn't there.
- If a single build must serve both, at minimum drop the `localStorage` and
  `?testBridge=1` activation paths from release builds (keep only the build flag),
  and extend the backend "refuse unless `TERMIHUB_TEST_BRIDGE_PORT`" gate to
  cover every verb with backend blast radius, not just `severAgentTransport`.
