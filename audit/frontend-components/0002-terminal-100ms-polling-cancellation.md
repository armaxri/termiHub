---
id: FEC-002
title: Terminal connect/retry loop polls a boolean every 100ms instead of using an abort signal
angle: frontend-components
severity: medium
category: workaround
is_workaround: true
subsystem: src/components/Terminal
evidence:
  - src/components/Terminal/Terminal.tsx:727
  - src/components/Terminal/Terminal.tsx:739
  - src/components/Terminal/Terminal.tsx:481
status: open
---

## What
The agent auto-retry path in `setupTerminal` implements its cancellable delays
by busy-waiting: it loops `while (Date.now() < deadline)` and `await`s a
`setTimeout(r, 100)` each iteration, re-checking `isCanceled()`. This runs for a
3 s "visible failure" hold and a 2.5 s retry backoff, i.e. ~55 wakeups per
failed attempt.

## Why it matters
Cancellation is modelled as a polled boolean (`isCanceled()`) rather than an
`AbortSignal`, so teardown latency is bounded by the 100 ms poll interval and
every waiting terminal wakes the event loop 10×/second while a connection is
failing. With several agent tabs retrying at once this is measurable idle churn
in a WebView. It is also brittle: the same `isCanceled` closure is threaded
through `waitForBackendAgentReconnectOutcome`, `waitForUsableDimensions`, and the
connect loop, and any missed check leaves work running after unmount.

## Evidence
`src/components/Terminal/Terminal.tsx:727-743`
```ts
const failDeadline = Date.now() + 3000;
while (Date.now() < failDeadline) {
  if (isCanceled()) return;
  await new Promise<void>((r) => setTimeout(r, 100));
}
...
const deadline = Date.now() + 2500;
while (Date.now() < deadline) {
  if (isCanceled()) return;
  await new Promise<void>((r) => setTimeout(r, 100));
}
```

## Recommendation
Replace the polled boolean with an `AbortController` created in the effect and
aborted in cleanup. Delays become a single cancellable
`await sleep(ms, signal)` that rejects/resolves immediately on abort (one timer,
zero polling), and the async helpers take the `signal` instead of an
`isCanceled` closure. This removes the polling wakeups and makes cancellation
deterministic and instant.
