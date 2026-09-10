---
id: WA-FE-009
title: 50ms setTimeout defers real session teardown to survive React StrictMode double-mount
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: components/Terminal
evidence:
  - src/components/Terminal/Terminal.tsx:1044
  - src/components/Terminal/Terminal.tsx:1050
  - src/components/Terminal/Terminal.tsx:1054
status: open
---

## What
On terminal cleanup, the actual backend teardown (`detachPersistentTab` or `closeTerminal`) is
deferred by an arbitrary 50ms `setTimeout` so a React StrictMode rapid unmount→remount can cancel
it before the backend session is destroyed:

```ts
// Defer the close so that React StrictMode's rapid unmount→remount
// can cancel it before the backend session is destroyed.
pendingCloseTimerRef.current = setTimeout(() => { detachPersistentTab(sid, tabId).catch(() => {}); }, 50);
```

## Why it matters
- The 50ms is a guessed delay tuned to the observed StrictMode remount gap. It is not derived from
  any signal; a slower remount (loaded machine, dev build) could exceed it and still tear down a
  session that was about to be re-adopted, or a genuine close could be raced by an unrelated
  remount within the window.
- It only exists to paper over StrictMode's intentional double-invocation of effects — a
  development-mode behavior — so the mechanism is a dev-artifact leaking into the teardown path.

## Evidence
`src/components/Terminal/Terminal.tsx:1044-1064` — both the persistent-detach and the
`closeTerminal` branches arm a 50ms `pendingCloseTimerRef` timer; a StrictMode remount clears it.

## Recommendation
Prefer a deterministic mount-generation / adoption handshake over a timing guess: mark the session
as "pending-close" and have the remount claim it synchronously (the code already has an
`isSessionMoving` flag for the multi-window case — extend that idea to StrictMode remounts) so the
close fires only when no remount has claimed the session, with no wall-clock dependency. Removing
the `setTimeout(…, 50)` teardown deferral is the signal.
