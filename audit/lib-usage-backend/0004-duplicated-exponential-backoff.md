---
id: LIBBE-004
title: Consolidate ~8 hand-rolled exponential-backoff computations into one helper (crate optional)
angle: lib-usage-backend
severity: low
category: arch
is_workaround: false
subsystem: cross-cutting (reconnect / retry)
evidence:
  - core/src/reconnect_backoff.rs:134
  - core/src/monitoring/status.rs:107
  - core/src/backends/ftp/reconnect.rs:24
  - src-tauri/src/tunnel/tunnel_manager.rs:1767
  - src-tauri/src/files/transfer/retry.rs:28
  - src-tauri/src/terminal/agent_manager.rs:2626
  - agent/src/monitoring/mod.rs:288
status: open
---

## What
At least **eight** separate places compute a capped exponential backoff delay,
each hand-rolling the `base * factor^n` (clamped) math with its own give-up /
jitter / cap semantics:

- `core/src/reconnect_backoff.rs:134` — `backoff_delay` + `next_reconnect_delay`
  (full state machine with jitter; a deliberate faithful port of the frontend
  `reconnectBackoff.ts`).
- `core/src/monitoring/status.rs:107` — `BackoffSchedule::next_delay` (`2u32.saturating_pow`).
- `core/src/backends/ftp/reconnect.rs:24` — reconnect ramp.
- `core/src/backends/ssh/monitoring.rs:287` — bounded exponential re-dial.
- `src-tauri/src/tunnel/tunnel_manager.rs:1767` — `backoff_delay(attempt, base, cap)` (`2u32.saturating_pow`).
- `src-tauri/src/files/transfer/retry.rs:28` — `backoff_delay(failed_attempts)` (`1u32.checked_shl`).
- `src-tauri/src/terminal/agent_manager.rs:2626` — `min(2u64.pow(attempt), MAX_BACKOFF_SECS)`.
- `agent/src/monitoring/mod.rs:288` — bounded exponential re-open.

## Why it matters
This is more a **code-duplication / maintenance** observation than a missing-crate
one, and the honest buy-vs-build verdict is nuanced:

- The **delay math itself is trivial** (`base * 2^n`, clamped) and does not, on
  its own, justify pulling in a crate. Several of these also embed
  domain-specific give-up conditions (attempt budget → surface a manual overlay,
  `REST`-resume interplay, transport re-establishment) that a generic backoff
  crate would not subsume.
- But eight independent copies **drift**: they already differ in overflow
  handling (`saturating_pow` vs `checked_shl` vs plain `pow`, which can panic in
  debug on a large `attempt`), in whether jitter is applied, and in the cap
  units. That divergence is the actual cost.

## Evidence
See the `evidence` list; `rg "exponential backoff"` and `rg "saturating_pow|checked_shl|2u64.pow|powi"`
across the three crates enumerate them. Note `agent_manager.rs:2626` uses
`2u64.pow(attempt)` (non-saturating) — a large `attempt` would panic in a debug
build, a latent sharp edge the others avoid.

## Recommendation
**low priority; consolidate rather than add a crate.** Extract one small internal
helper — e.g. `termihub_core::backoff::capped_exponential(attempt, base, factor,
cap, jitter)` returning a `Duration` — and route the ad-hoc call sites through it
(the `reconnect_backoff.rs` state machine can keep its phase logic but call the
shared delay fn). This removes the overflow-handling divergence and the
`2u64.pow` panic edge with no new dependency.

A crate (`backon`, `tokio-retry`, `exponential-backoff`) is **optional** and only
worth it if the team also wants the retry *driver* (sleep + execute + give-up
loop), which some sites hand-roll too — but those loops are entangled with
domain state (session lifecycle, tunnel redrive), so keeping the driver in-house
and sharing only the delay math is the pragmatic call.
</content>
