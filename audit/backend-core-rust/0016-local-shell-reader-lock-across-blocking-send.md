---
id: CORE-016
title: Local-shell reader holds the output-sender mutex across a blocking_send (deadlock/backpressure stall)
angle: backend-core-rust
severity: high
category: reliability
is_workaround: false
subsystem: core/backends/local_shell
evidence:
  - core/src/backends/local_shell.rs:549
status: open
---

## What
The PTY reader thread locks the shared `output_tx` mutex and then performs a
**blocking** channel send while still holding the lock:

```rust
let guard = output_tx_clone.lock().ok();
if let Some(ref guard) = guard {
    if let Some(ref sender) = **guard {
        // blocking_send blocks if channel full (backpressure).
        let _ = sender.blocking_send(data);
    } else {
        break;
    }
}
```

## Why it matters
`blocking_send` parks the thread when the channel is full (slow consumer /
backpressure) while the `output_tx` mutex is held. Any other code path that needs
that mutex (e.g. teardown clearing the sender to stop the session, or a
disconnect) then blocks behind a reader that is itself blocked on a full channel
— a lockup where the session can neither drain nor be torn down. The comment
acknowledges the blocking behaviour but not that it happens under the lock.

## Evidence
`core/src/backends/local_shell.rs:544-560`.

## Recommendation
Clone the `Sender` out of the guard (or store it behind an `ArcSwap`/atomic) and
drop the mutex before `blocking_send`, so the lock is never held across a
potentially-parking send.
