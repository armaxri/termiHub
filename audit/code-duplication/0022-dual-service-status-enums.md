---
id: DUP-022
title: Two status enums (ServiceStatus vs ServerStatus) model one lifecycle, mapped twice
angle: code-duplication
severity: low
category: arch
is_workaround: false
subsystem: core/service vs core/embedded_servers
evidence:
  - core/src/service/mod.rs:51
  - core/src/embedded_servers/config.rs:56
  - src-tauri/src/embedded_servers/server_manager.rs:670
status: open
---

## What

`ServiceStatus` (Stopped/Starting/Running/Stopping/Failed) and `ServerStatus`
(Stopped/Starting/Running/Stopping/Error) model the same lifecycle with different last-variant
names. The mapping between them is written twice: `EmbeddedServerService::state()` and the desktop's
`synth_state_from_status`.

## Why it matters

Low and partly intentional — `ServerStatus` predates the `Service` lift and is kept for the frontend
`ServerState` contract — but it is a standing translation surface with two hand-written mappings that
can disagree (e.g. on how `Failed`/`Error` carries its message).

## Evidence

- `core/src/service/mod.rs:51` — `ServiceStatus`.
- `core/src/embedded_servers/config.rs:56` — `ServerStatus`.
- `core/src/embedded_servers/service.rs:378` (`state()`) and
  `src-tauri/src/embedded_servers/server_manager.rs:670` (`synth_state_from_status`) — the two maps.

## Recommendation

Collapse to one status enum (or make `ServerStatus` a serde-renamed alias of `ServiceStatus`) and
keep a single conversion in core. If the frontend name must stay `error`, express it as a serde
rename rather than a second enum + a second mapping.
