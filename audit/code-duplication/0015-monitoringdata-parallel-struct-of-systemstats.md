---
id: DUP-015
title: MonitoringData is a hand-maintained parallel copy of core SystemStats
angle: code-duplication
severity: medium
category: reliability
is_workaround: false
subsystem: agent/protocol/methods.rs + agent/monitoring/mod.rs vs core/monitoring/types.rs
evidence:
  - agent/src/protocol/methods.rs:648
  - core/src/monitoring/types.rs:11
  - agent/src/monitoring/mod.rs:351
status: open
---

## What

`agent::protocol::methods::MonitoringData` redeclares all 11 fields of core `SystemStats` verbatim,
adding only `host`, and `agent/src/monitoring/mod.rs` does a manual field-by-field copy from
`SystemStats` into `MonitoringData` on every sample. So a single stats payload is defined in two
structs and bridged by a hand-written copy block.

## Why it matters

The frontend consumes both the agent's `connection.monitoring.data` notification (from
`MonitoringData`) and the desktop's `session-monitoring-stats` event (from `SystemStats`). Any field
added to `SystemStats` is silently dropped from the agent notification unless someone also edits
`methods.rs` **and** the copy block — three edit sites, no compiler help. Asymmetry compounds it:
`SystemStats` is `Serialize + Deserialize`, `MonitoringData` is `Serialize`-only.

## Evidence

- `core/src/monitoring/types.rs:11-23` — canonical `SystemStats`.
- `agent/src/protocol/methods.rs:648-662` — `MonitoringData` redeclaring the same 11 fields + `host`.
- `agent/src/monitoring/mod.rs:351-364` — manual field-by-field copy block.

## Recommendation

Delete the parallel struct; define the wire payload as a thin wrapper over core, e.g. in
`core::monitoring::types`: `struct HostStats { host: String, #[serde(flatten)] stats: SystemStats }`
(or `#[serde(flatten)]` `SystemStats` inside the agent struct). Removes the copy block and makes a
field addition one-touch. (Note: parsing, CPU-delta math, status/backoff, and the HTTP monitor are
already correctly centralized in `core::monitoring` — this is the one real drift there.)
