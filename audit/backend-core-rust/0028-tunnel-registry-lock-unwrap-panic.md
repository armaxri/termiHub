---
id: CORE-028
title: Tunnel registry mutex lock().unwrap() panics on poison, killing unrelated forwarders
angle: backend-core-rust
severity: low
category: reliability
is_workaround: false
subsystem: core/tunnel
evidence:
  - core/src/tunnel/remote_forward.rs
status: open
---

## What
Tunnel forwarder registries use `.lock().unwrap()` on their std mutex (reported by
the tunnel/ipc/network audit), so a panic while the lock is held poisons the
mutex and every subsequent `lock().unwrap()` panics.

## Why it matters
One panicking forwarder task poisons the shared registry lock, cascading panics
into all other tunnels sharing it. This is the same lock-poison-propagation
pattern the workaround-rust angle flagged app-wide; noted here for the core tunnel
registries specifically.

## Evidence
`core/src/tunnel/remote_forward.rs` (and sibling forwarders) — `lock().unwrap()`
on the active-forwarder maps.

## Recommendation
Recover from poison (`lock().unwrap_or_else(|e| e.into_inner())`) or move to a
lock strategy that does not propagate poison, so one failed forwarder cannot take
down the rest.
