---
id: CONC-010
title: Backend reader threads hold the output_tx mutex across blocking_send
angle: concurrency-reliability
severity: medium
category: reliability
is_workaround: false
subsystem: core/backends
evidence:
  - core/src/backends/local_shell.rs:549
  - core/src/backends/wsl.rs:875
  - core/src/backends/telnet.rs:338
  - core/src/backends/ssh/mod.rs:630
  - core/src/plugin/connection.rs:341
  - core/src/backends/local_shell.rs:595
status: fixed
resolution: "#2771 — output_tx lock released before send (wsl/telnet/ssh; docker/serial already safe)"
---

## What

Every PTY/socket backend runs a dedicated OS reader thread that locks a
`std::sync::Mutex<Option<Sender>>` output slot and then calls `sender.blocking_send(..)` **while
still holding the guard**:

- `local_shell.rs:549-553`, `wsl.rs:875-878`, `telnet.rs:338-341`, `ssh/mod.rs:630-633`,
  `plugin/connection.rs:341-347`.

`blocking_send` blocks while the bounded channel is **full but open** (consumer backpressure). While
it blocks, the guard is held, so any other thread that locks the same `output_tx` — notably the
child-exit watcher that clears the slot to `None` on process exit (`local_shell.rs:595`) — stalls
until the async consumer drains.

## Why it matters

This is the same class the audit brief already flagged (a local-shell reader holding a mutex across
`blocking_send`), and it is **replicated across five backends**. It is bounded, not a hard deadlock:
once the receiver is dropped, `blocking_send` returns `Err` immediately, so a *closed* consumer
frees the lock. But a *slow* consumer (a stalled frontend / backed-up forwarder) pins the output
lock and delays session teardown and exit detection — the exit watcher can't record the exit, and
`close`/cleanup paths that need the lock hang behind a live-but-slow consumer.

## Evidence

```rust
// local_shell.rs (pattern repeated in wsl/telnet/ssh/plugin):
if let Some(sender) = guard.as_ref() {           // guard: MutexGuard<Option<Sender>>
    if sender.blocking_send(chunk).is_err() { ... }  // :549-553  blocks on backpressure, guard still held
}
```

## Recommendation

Clone the `Sender` out of the mutex, drop the guard, then `blocking_send` on the clone — the lock
protects the *slot*, not the send. This is a small, mechanical change repeated across the five
backends and removes the teardown-vs-slow-consumer stall. Consider a shared helper so the pattern is
fixed once and reused.
</content>
