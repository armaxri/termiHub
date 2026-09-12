---
id: PROD-036
title: Embedded server stats are minimal (aggregate counters only)
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: core/embedded_servers
evidence:
  - src/types/embeddedServer.ts:27
status: open
---

## What
`ServerStats` carries only aggregate counters; there is no per-request/per-transfer detail.

## Why it matters
Beyond a single stats line, users have no visibility into individual connections/transfers.

## Evidence
- `src/types/embeddedServer.ts:27-33` and `AtomicServerStats` in `core/src/embedded_servers/config.rs` — aggregate only.

## Recommendation
Track per-connection/per-transfer records (overlaps with the access-log finding PROD-034).
