---
id: CORE-027
title: SSH tunnel forwarders accept unbounded concurrent connections with no idle timeout
angle: backend-core-rust
severity: medium
category: reliability
is_workaround: false
subsystem: core/tunnel
evidence:
  - core/src/tunnel/local_forward.rs
  - core/src/tunnel/dynamic_forward.rs
status: fixed
resolution: "#2803 — tunnel forwarders: Semaphore MAX_CONCURRENT_FORWARDED_CONNECTIONS=256 across all 3 forwarders"
---

## What
The local/dynamic forwarders spawn a task per accepted connection with no cap on
concurrent forwarded channels and no idle/lifetime timeout (reported by the
tunnel/ipc/network audit).

## Why it matters
A local listener (SOCKS proxy / local-forward) is reachable by any local process;
an aggressive or buggy client can open unbounded forwarded SSH channels, each
consuming an SSH channel + task + buffers, exhausting the SSH connection's channel
budget and host memory. Half-open connections never time out, so leaked channels
accumulate.

## Evidence
`core/src/tunnel/local_forward.rs`, `core/src/tunnel/dynamic_forward.rs` accept
loops (`tokio::spawn` per accept, no semaphore, no timeout on the copy loop).

## Recommendation
Bound concurrent forwarded connections (semaphore), and apply an idle timeout to
the bidirectional copy so dead connections are reaped.
