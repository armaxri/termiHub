---
id: WA-FE2-005
title: "Cancellation by polling persists: Terminal busy-sleep loops and new workflow setInterval cancel polls"
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: "components/Terminal + store/slices/workflowRunOnTarget"
evidence:
  - src/components/Terminal/Terminal.tsx:822
  - src/components/Terminal/Terminal.tsx:825
  - src/components/Terminal/Terminal.tsx:834
  - src/components/Terminal/Terminal.tsx:837
  - src/components/Terminal/Terminal.tsx:460
  - src/store/slices/workflowRunOnTarget.ts:361
  - src/store/slices/workflowRunOnTarget.ts:434
  - src/store/slices/workflowRunOnTarget.ts:60
  - src/store/slices/workflowRunOnTarget.ts:63
  - src/services/workflowRunner.ts:367
  - src/services/workflowRunner.ts:373
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: WA-FE-012
---

## What

WA-FE-012 named both the sessionBridge polls and the Terminal.tsx agent auto-retry loops as evidence. Fix #3012 converted only sessionBridge. The two `while (Date.now() < deadline) { if (isCanceled()) return; await setTimeout(100) }` loops (3s fail display, 2.5s retry delay) remain at Terminal.tsx:822-838, even though the effect now holds a real `AbortSignal` (Terminal.tsx:460). New code added 2026-09-26 repeats the pattern: workflowRunOnTarget.ts:361 and :434 poll `options.signal?.isCancelled()` every 200ms, although `WorkflowStepSignal` already carries a `whenCancelled` promise (workflowRunner.ts:367-373) built for exactly this purpose.

## Why it matters

These are timer-polling stand-ins for event-driven cancellation. Each one wakes the event loop for the whole wait, observes a cancel up to 100–200ms late (a late cancel can still kill a local process or finish a wait), and keeps the WA-FE-012 smell alive despite its 'fixed' status.

## Evidence

- `src/components/Terminal/Terminal.tsx:822`
- `src/components/Terminal/Terminal.tsx:825`
- `src/components/Terminal/Terminal.tsx:834`
- `src/components/Terminal/Terminal.tsx:837`
- `src/components/Terminal/Terminal.tsx:460`
- `src/store/slices/workflowRunOnTarget.ts:361`
- `src/store/slices/workflowRunOnTarget.ts:434`
- `src/store/slices/workflowRunOnTarget.ts:60`
- `src/store/slices/workflowRunOnTarget.ts:63`
- `src/services/workflowRunner.ts:367`
- `src/services/workflowRunner.ts:373`

## Recommendation

In Terminal.tsx, replace both loops with an abortable sleep, e.g. `await abortableDelay(3000, signal)`, a helper that resolves early on `signal.addEventListener('abort', ...)`. In workflowRunOnTarget, drop both `setInterval`s and use `options.signal?.whenCancelled?.then(() => { void cancelLocalProcess(id) })` / `.then(() => finish({cancelled:true}))`, guarded by a settled flag.

## Verification

Confirmed. Terminal.tsx:822-838 still has two `while (Date.now()<deadline){ if(isCanceled()) return; await setTimeout(100) }` loops, though isCanceled is now derived from a real AbortSignal (line 460). The WA-FE-012 file listed Terminal.tsx cancel-sleeps as evidence, yet the #3012 resolution only mentions sessionBridge. workflowRunOnTarget.ts:361 and :434 add setInterval polls of options.signal.isCancelled(), even though WorkflowStepSignal.whenCancelled exists (workflowRunner.ts:367-375). The impact is minor: up to 100-200ms cancel latency plus timer wakeups.
