---
id: FES2-006
title: "useNetworkTask can start a backend task after unmount that nothing cancels, and leaks its listeners"
angle: frontend-state
severity: low
category: reliability
is_workaround: false
subsystem: src/hooks/useNetworkTask.ts
evidence:
  - src/hooks/useNetworkTask.ts:93
  - src/hooks/useNetworkTask.ts:107
  - src/hooks/useNetworkTask.ts:108
  - src/hooks/useNetworkTask.ts:131
status: fixed
resolution: "#4375 — run token cancels a task started after unmount or supersession; late listeners dropped; finished runs never re-arm the id"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

run() awaits subscribe(ctx) and then start(). The unmount cleanup cancels only taskIdRef.current, which is still null at that point, and tears down the listeners that exist at that moment. If the panel unmounts during either await: listeners registered afterwards via ctx.register are never removed, and start() still runs and stores its id with nobody left to cancel it. A long port scan or traceroute then keeps running in the backend with no UI. Similarly, finish() → teardown() can reset taskIdRef before start() resolves, and the `taskIdRef.current = await start()` assignment then re-arms the id of an already finished task.

## Why it matters

Closing a network-tools panel right after pressing Run leaves an orphaned backend diagnostic, plus event listeners, for the rest of the session. The race window is small, but the result is a runaway port scan.

## Evidence

- `src/hooks/useNetworkTask.ts:93`
- `src/hooks/useNetworkTask.ts:107`
- `src/hooks/useNetworkTask.ts:108`
- `src/hooks/useNetworkTask.ts:131`

## Recommendation

Track a per-run token or an unmounted ref. After each await in run(), if the hook unmounted or a newer run started, tear down the run's listeners and cancel the started task id (`void cancel(id)`) instead of storing it. Only assign taskIdRef if the run has not already finished.

## Verification

Confirmed. In useNetworkTask.ts:93-111, run() awaits subscribe(ctx) and then start(). The unmount cleanup cancels only taskIdRef.current, which is null during those awaits, and tears down only the listeners present at that moment. Listeners registered later via ctx.register, and the task id that start() returns afterwards, are never cleaned up or cancelled, so a port scan or traceroute can keep running in the backend after the panel unmounts. A complete event before start resolves (matchesTask accepts any id while taskIdRef is null) also lets teardown run, and the id is then re-assigned. The race window is narrow, so low.
