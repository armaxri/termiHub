---
id: WA-RS-001
title: Embedded HTTP server shutdown uses a 100ms poll loop instead of an event
angle: workaround-rust
severity: medium
category: workaround
is_workaround: true
subsystem: core/embedded_servers
evidence:
  - core/src/embedded_servers/http_server.rs:236
status: fixed
resolution: "#2781 — http-event shutdown"
---

## What
The embedded HTTP server's graceful-shutdown future polls an `AtomicBool` every
100ms in a busy loop rather than awaiting an event:

```rust
.with_graceful_shutdown(async move {
    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
})
```

## Why it matters
This is polling where an event should exist. It adds up to ~100ms of shutdown
latency and wakes the runtime 10x/second for the entire lifetime of every
running embedded HTTP server (there can be several). It papers over the lack of a
proper shutdown signal.

## Recommendation
Replace the `AtomicBool` + poll loop with an event primitive: a
`tokio::sync::watch` channel, a `tokio::sync::Notify`, or a oneshot `Receiver`
awaited directly inside the `with_graceful_shutdown` closure. Shutdown then
fires immediately with zero idle wakeups. Check whether the FTP/TFTP embedded
servers share the same pattern and fix them together.
