---
id: PROD-029
title: Monitoring metric set is narrow — no network I/O, swap, or per-core CPU
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: core/monitoring
evidence:
  - core/src/monitoring/types.rs:11
status: open
---

## What
`SystemStats` collects CPU%, memory, disk, load, uptime, hostname, os_info — but no network
rx/tx throughput, no swap, and no per-core CPU. README advertises "network stats".

## Why it matters
The README lists "network stats" under SSH monitoring, but no network throughput is collected
— a documentation/feature mismatch. Swap pressure and per-core load are also commonly expected.

## Evidence
- `core/src/monitoring/types.rs:11-22` — no network/swap/per-core fields.
- No `net/rx/tx/per-core/swap` collection in `agent/src/monitoring/collector.rs` / `core/src/monitoring/parser.rs`.

## Recommendation
Collect network rx/tx (and swap, per-core) and display them; reconcile the README claim of
"network stats" with what is actually collected.
