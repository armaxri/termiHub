---
id: FEC-014
title: Session teardown deferred by fixed setTimeout(50) to survive StrictMode remount
angle: frontend-components
severity: low
category: workaround
is_workaround: true
subsystem: src/components
evidence:
  - src/components/Terminal/Terminal.tsx:1050
  - src/components/Terminal/Terminal.tsx:1054
  - src/hooks/useRemoteDesktopSession.ts:204
status: open
---

## What
Both the Terminal cleanup and `useRemoteDesktopSession` cleanup defer the actual
backend close/disconnect behind a hardcoded `setTimeout(..., 50)`, so that React
StrictMode's synchronous unmount→remount can cancel the pending close (via
`pendingCloseTimerRef` / `pendingCloseRef`) before the backend session is
destroyed.

## Why it matters
The 50 ms window is a guess: it couples correctness (not killing a session that
is about to re-attach) to a timing constant with no lower bound guarantee. On a
loaded machine a legitimate StrictMode remount could exceed 50 ms and destroy a
session that was about to be reused; conversely the delay adds latency to every
real close. It is a development-only concern (StrictMode) leaking a magic number
into production teardown paths.

## Evidence
`src/components/Terminal/Terminal.tsx:1050-1063`,
`src/hooks/useRemoteDesktopSession.ts:204-208`.

## Recommendation
Tie the "was this a real unmount?" decision to identity, not time: on remount,
detect that the same tab/session is being set up again and reclaim the pending
close synchronously (the refs already exist to do this) rather than relying on
the 50 ms race. Where a defer is still wanted, derive the reattach decision from
a mount-generation token instead of wall-clock timing.
