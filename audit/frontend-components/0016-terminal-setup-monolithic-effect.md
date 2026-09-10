---
id: FEC-016
title: Terminal connection state machine is a ~700-line async function inside a component effect
angle: frontend-components
severity: medium
category: arch
is_workaround: false
subsystem: src/components/Terminal
evidence:
  - src/components/Terminal/Terminal.tsx:375
  - src/components/Terminal/Terminal.tsx:1110
status: open
---

## What
`Terminal.tsx` is 1733 lines and its core is `setupTerminal` — a single ~700-line
`useCallback` async function (`:375-1080`) that implements the entire
connect/reattach/reconnect/agent-retry/backend-redrive state machine while
directly reading and writing ~20 distinct store slices imperatively
(`useAppStore.getState().setTerminalConnecting/…AutoRetrying/…SpawnError/…
WaitingForAgent/…` etc.), interleaved with xterm I/O wiring, sandbox pipeline
setup, line-ending/logging pushes, and a hand-written cleanup closure. It is
driven by an equally large creation effect (`:1110-1563`) with an 11-entry
dependency array and two `exhaustive-deps` suppressions.

## Why it matters
This is the most correctness-critical component in the app (it owns live PTY
sessions and reconnect), yet its logic is untestable in isolation: the branching
connect/reattach/redrive machine can only be exercised through a fully-mounted
xterm + store + Tauri harness. The file already carries a dense trail of
regression references (#952, #1125, #1126, #1214, #1900, #2205, #2439, #2476,
#2512, #2682, #2700) — evidence that changes here are high-risk and repeatedly
re-broken. The imperative `getState().setX()` scatter also means the connection
state transitions are not expressible as a diagram or reducer, so no one can read
the machine in one place. This exceeds the repo's own "~500 lines/file, ~50
lines/function" guideline by an order of magnitude on the highest-stakes code.

## Why it is not just style
The size directly causes the other Terminal findings (FEC-001/002/003/014): the
polling loops, magic timers, and private-internal reads are buried where they are
hard to spot and impossible to unit-test. Splitting the machine out makes each of
those fixable and testable in isolation.

## Recommendation
Extract the connection/reconnect state machine into a framework-free module (a
reducer or explicit FSM) that takes the transport/store as injected dependencies
and is unit-tested against connect/reattach/redrive/agent-retry/cancel
transitions without a DOM. The component keeps only xterm lifecycle + wiring. This
is the enabling refactor for verifying the reconnect paths the release depends on.
