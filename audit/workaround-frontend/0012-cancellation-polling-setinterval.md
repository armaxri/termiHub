---
id: WA-FE-012
title: setInterval(100) cancellation-polling instead of an abort signal in session waits
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: store/sessionBridge + components/Terminal
evidence:
  - src/store/sessionBridge.ts:771
  - src/store/sessionBridge.ts:883
  - src/components/Terminal/Terminal.tsx:728
  - src/components/Terminal/Terminal.tsx:740
status: open
---

## What
Several async waits poll a `isCanceled()` predicate on a 100ms `setInterval` (or a
`while (Date.now() < deadline) { await setTimeout(…, 100) }` loop) so a torn-down effect stops
waiting, because the wait is not wired to an abort signal:

```ts
// sessionBridge.ts:771 / :883
const cancelPoll = setInterval(() => { if (isCanceled()) finish(null); }, 100);
```
```ts
// Terminal.tsx:728-731 / :740-743 — cancellable-sleep by 100ms polling
while (Date.now() < failDeadline) { if (isCanceled()) return; await new Promise(r => setTimeout(r, 100)); }
```

## Why it matters
- The wait can linger up to ~100ms after the effect is actually torn down, and the polling runs
  continuously for the whole wait window. It is a stand-in for event-driven cancellation.
- Low blast radius (correct, just imprecise and slightly wasteful), but it is the kind of
  timer-polling stopgap the audit collects.

## Evidence
`src/store/sessionBridge.ts:767-774` and `:881-886`; `src/components/Terminal/Terminal.tsx:726-743`
(the two cancellable-delay loops in the agent auto-retry path).

## Recommendation
Thread an `AbortController`/`AbortSignal` through these waits so cancellation is an event
(`signal.addEventListener("abort", …)`) that settles the promise immediately, replacing the
100ms poll and the busy-sleep loops. Zero `setInterval(…, 100)`-for-cancellation in the bridge is
the signal.
