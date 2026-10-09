---
id: TFE2-001
title: "Agent reconnect resume/lost/disconnect handler in TerminalView has no coverage; its tests re-implement the handler instead of calling it"
angle: test-frontend
severity: medium
category: test-gap
is_workaround: false
subsystem: "src/components/Terminal/TerminalView.tsx (agent-state-change listener)"
evidence:
  - src/components/Terminal/TerminalView.tsx:124-271
  - src/components/Terminal/TerminalView.tsx:97-121
  - src/components/Terminal/TerminalView.tsx:401-422
  - src/components/Terminal/TerminalView.agent-disconnect.test.ts:411-436
  - src/components/Terminal/TerminalView.agent-disconnect.test.ts:290-296
  - src/components/Terminal/TerminalView.agent-disconnect.test.ts:499-512
  - src/components/Terminal/agentStateHandlers.ts:35
status: fixed
resolution: "#4309 — the handler is extracted to handleAgentStateChange/handleRemoteStateChange and tested directly; the hand-copied test loops are gone and TerminalView's wiring is pinned"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The real `agent-state-change` listener in TerminalView.tsx (lines 124-271) has 0 hits in the CI lcov for this commit; TerminalView.tsx overall is 42% lines / 31% branches. That listener holds a lot of logic: tab discovery, `listAgentSessions` with its catch fallback that treats every session as gone, the resume-vs-sessionLost gate that accepts both the `reconnecting` and `sessionLost` race states, `settleSessionLost`, and the disconnected-with-error branch (`settleBackendReconnectGaveUp`) versus `setTerminalExited`. TerminalView.agent-disconnect.test.ts never mounts the component or fires the event. Instead it defines `simulateConnectedHandler` (a hand copy of the handler loop) and inline copies of the disconnected loop, and asserts on those. Example: the test titled "marks all reconnecting tabs as exited when listAgentSessions fails" (line 499) never calls listAgentSessions; it passes `[]` to the copy. Only `restartAgentRetryTabs` was switched to the real function (#3686). The panel-close confirm-before-killing-live-sessions path (`handleClosePanel`, lines 401-422) is also uncovered.

## Why it matters

Agent reconnect is the app's headline reliability feature, and the bar is ventilator grade. A change to the real handler (a reordered branch, a dropped catch, a wrong settle call) leaves these tests green, because they exercise a private copy. They give false confidence on the exact path the #2476/#2205 inversion rewired, and the panel-close confirmation guards against killing live sessions.

## Evidence

- `src/components/Terminal/TerminalView.tsx:124-271`
- `src/components/Terminal/TerminalView.tsx:97-121`
- `src/components/Terminal/TerminalView.tsx:401-422`
- `src/components/Terminal/TerminalView.agent-disconnect.test.ts:411-436`
- `src/components/Terminal/TerminalView.agent-disconnect.test.ts:290-296`
- `src/components/Terminal/TerminalView.agent-disconnect.test.ts:499-512`
- `src/components/Terminal/agentStateHandlers.ts:35`

## Recommendation

Move the listener body into a pure, exported `handleAgentStateChange(payload, { store, listAgentSessions, getAllTabs, sessionView })` in agentStateHandlers.ts, next to applyAgentReconnecting/wakeWaitingAgentTabs. Do the same for the remote-state-change handler. TerminalView then just calls it from `listen`. Rewrite the agent-disconnect tests to call the real function, with `listAgentSessions` mocked to resolve and to reject. Delete `simulateConnectedHandler` and the inline disconnected loops. Add one test that mounts TerminalView and emits the event through the mocked `listen` to pin the wiring, and a test for handleClosePanel's liveCount>0 confirm path.

## Verification

I confirmed the gap from the code. The `agent-state-change` listener is an inline async closure inside a useEffect in TerminalView.tsx (lines 124-271). It is not exported or extracted, so no test can call it. Only the `reconnecting` branch and the wake/restart helpers delegate to agentStateHandlers.ts.

No test emits `agent-state-change` into a mounted TerminalView. The only test files that mention the event are TerminalView.agent-disconnect.test.ts, agentStateHandlers.wake-park.test.ts and appStore.connectAgentBranches.test.ts.

TerminalView.agent-disconnect.test.ts re-implements the handler logic:

- `simulateConnectedHandler` (lines 411-436) is a hand copy of the connected loop.
- The "listAgentSessions fails" test (499-512) passes `[]` to that copy and never calls `listAgentSessions`.
- The 'disconnected' test (281-298) inlines its own loop that calls `setTerminalExited`.

So reordering branches, dropping the catch, or swapping `settleSessionLost`/`settleBackendReconnectGaveUp` in the real handler would leave these tests green. I found no test for `handleClosePanel` (401-422), and no ADR or audit note that accepts this gap on purpose.

I lowered severity from high to medium:

- This is a missing test, not a shown defect. The real handler matches the copies today.
- After #2556/#2564/#2612, the backend owns the region folds at the source and has Rust tests. The frontend handler only does presentation settling and clears in-flight flags, so a regression there is less dangerous.
- The countLiveSessions helper and the confirm dialog behind the panel-close path have their own tests elsewhere.

It is still worth fixing, because the reconnect path must meet the ventilator-grade bar. The suggested extraction into agentStateHandlers.ts is sound.

I could not check the coverage figures myself (0 hits, 42% lines). That does not matter: the code shows the gap structurally.
