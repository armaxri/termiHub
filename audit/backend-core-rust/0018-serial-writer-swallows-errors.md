---
id: CORE-018
title: Serial write errors are swallowed; a failed/unplugged port keeps reporting "connected"
angle: backend-core-rust
severity: medium
category: reliability
is_workaround: false
subsystem: core/backends/serial
evidence:
  - core/src/backends/serial.rs
status: fixed
resolution: "#2795 — serial write err → mark dead + drop output sender (mirrors CORE-007)"
---

## What
The serial backend's write path discards write errors (`let _ = ...` / `.ok()`),
so a write to a port that has been unplugged or errored does not surface an error
or tear the session down (reported by the local/serial backend audit).

## Why it matters
On a physical serial link (the exact case where the device is pulled or the
adapter faults), lost writes with no error mean the UI still shows a live
session while input silently vanishes — the same silent-input-loss failure mode
as the SSH shell-write finding (CORE-007), on a backend whose whole purpose is
24/7 device capture.

## Evidence
`core/src/backends/serial.rs` write/reader paths. Cross-reference the ring-buffer
capture path (`core::buffer`) to confirm errors are not being masked there too.

## Recommendation
Propagate serial write errors: on write failure, mark the session disconnected
and surface an error to the frontend rather than dropping the result.
