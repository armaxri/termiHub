---
id: FEC-020
title: Plugin sandbox host — watchdog spreads all pending keys into Math.min, and the worker has no error handler
angle: frontend-components
severity: low
category: reliability
is_workaround: false
subsystem: src/plugins/sandbox
evidence:
  - src/plugins/sandbox/pluginSandboxHost.ts:185
  - src/plugins/sandbox/pluginSandboxHost.ts:87
status: open
---

## What
Two robustness gaps in the plugin sandbox host (main-thread side):

1. **`Math.min(...pending.keys())`** (`:185`) spreads every in-flight slot key
   across all sessions into a function-call argument list. `pending` is bounded
   per session (`MAX_PENDING_PER_SESSION = 1024`) but not globally, so with many
   sessions the spread can exceed the engine's argument-count limit and throw
   `RangeError` inside the watchdog — the one mechanism whose job is to keep the
   terminal flowing when a parser hangs.
2. **No worker `error`/`messageerror` handler** (`ensureWorker`, `:87` only adds
   a `message` listener). If the sandbox worker throws an uncaught error or dies,
   the host is not notified; outstanding slots rely solely on the 500 ms
   head-of-line watchdog to force-pass, and a repeatedly-crashing worker is never
   surfaced to the LogViewer.

## Why it matters
This is a default-off path (no parser → fully synchronous fast path), so impact
is low today. But the sandbox is the host-side of untrusted plugin code, and both
gaps degrade exactly when a plugin misbehaves — the case the sandbox exists to
contain. A watchdog that can itself throw is a latent liveness bug.

## Evidence
`src/plugins/sandbox/pluginSandboxHost.ts:179-189, 84-90`.

## Recommendation
Track the oldest pending seq with a running min (or iterate the map) instead of
spreading keys into `Math.min`. Add `worker.addEventListener("error", …)` /
`"messageerror"` that logs via `frontendLog` and force-drains/degrades pending
slots, so a dead worker is observable and the pipeline recovers.
