---
id: CONC-008
title: Graphical session manager holds the connection mutex across backend network I/O
angle: concurrency-reliability
severity: medium
category: reliability
is_workaround: false
subsystem: src-tauri/session/graphical_manager
evidence:
  - src-tauri/src/session/graphical_manager.rs:463
  - src-tauri/src/session/graphical_manager.rs:539
  - src-tauri/src/session/graphical_manager.rs:674
  - src-tauri/src/session/file_ops.rs:61
  - src-tauri/src/session/manager.rs:1133
status: open
---

## What

`graphical_manager.rs` holds a `tokio::sync::Mutex` guard over the backend connection across
backend network awaits throughout its methods — e.g. `get_clipboard().await` (463→467),
`disconnect().await` (539→540), `send_cert_decision(..).await` (674→676), and the same shape at
348→354, 365→371, 384→390, 416→422, 484→488, 511→517. The identical pattern appears in
`session/file_ops.rs:61-143` and `session/manager.rs:1133` (the `sessions` guard held across
`.await`).

## Why it matters

Same class as CONC-004/CONC-007: for the full duration of each backend I/O call, no other operation
on that connection/map can proceed, and a stalled backend (a hung RDP/VNC/clipboard/cert round-trip)
pins the lock. For graphical sessions the awaited calls are remote-desktop protocol I/O that can
block on network conditions, so a single slow clipboard fetch or a hung disconnect serializes every
other op on that session and risks a reentrancy deadlock if any callback re-enters the lock.

This is a lower blast radius than CONC-004 (per-connection rather than a shared session map) but is
the same systemic pattern and worth fixing as a set.

## Evidence

```rust
let conn = self.connection.lock().await;       // guard
... conn.get_clipboard().await ...             // :463→467 network I/O under the guard
... conn.disconnect().await ...                // :539→540
... conn.send_cert_decision(..).await ...      // :674→676
```

## Recommendation

Where the connection is an `Arc`, clone it under the lock and await on the clone; where it is not,
consider wrapping the backend in an `Arc` so callers can release the map/connection guard before
the network call. Audit `file_ops.rs` and `manager.rs:1133` for the same fix. These are correctness-
safe today (single connection, no concurrency within a browser/session) but remove the reentrancy-
deadlock footgun and the throughput cliff.
</content>
