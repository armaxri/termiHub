---
id: DUP-026
title: Pure transfer queue/state/scheduler/retry logic lives in src-tauri, not core
angle: code-duplication
severity: low
category: arch
is_workaround: false
subsystem: src-tauri/files/transfer (state, scheduler, retry)
evidence:
  - src-tauri/src/files/transfer/state.rs
  - src-tauri/src/files/transfer/scheduler.rs
  - src-tauri/src/files/transfer/retry.rs
status: open
---

## What

The backend-agnostic transfer domain logic — the `TransferState`/`TransferStateTag` machine +
`MAX_RETRIES`, the `SessionScheduler` FIFO slot accounting, and the `backoff_delay`/`resume_offset`/
`ThroughputMeter` (ETA) math — lives entirely in `src-tauri`. Each file's own doc header stresses it
is pure "no I/O, no async, no Tauri" logic. It is not duplicated in Rust today (the agent has no
transfer subsystem), but it is generic domain logic sitting in the app crate, and its concepts
(state tags, retry cap, ETA) are already mirrored by hand in the TS layer (see DUP-030).

## Why it matters

Low now. Two risks: (1) any future agent-side or remote transfer orchestration will re-implement it
rather than reuse it; (2) it feeds the Rust↔TS drift in DUP-030. The retry backoff here is also one
of the loops flagged in DUP-007.

## Evidence

- `src-tauri/src/files/transfer/state.rs` (state machine + `MAX_RETRIES`).
- `src-tauri/src/files/transfer/scheduler.rs` (`SessionScheduler`).
- `src-tauri/src/files/transfer/retry.rs` (`backoff_delay`, `resume_offset`, `ThroughputMeter`).

## Recommendation

Move the state machine + scheduler + retry/ETA math into `core::files::transfer`, leaving Tauri
event emission and the `State`-bound `TransferRegistry` in src-tauri. Unifies the backoff (DUP-007)
and gives a single home the frontend contract can be generated from (DUP-030).
