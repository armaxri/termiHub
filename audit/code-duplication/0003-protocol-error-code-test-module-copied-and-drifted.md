---
id: DUP-003
title: Protocol error-code test module is copy-pasted into the agent and has already drifted
angle: code-duplication
severity: low
category: test-gap
is_workaround: false
subsystem: agent/protocol/errors.rs vs core/protocol/errors.rs
evidence:
  - core/src/protocol/errors.rs:75
  - agent/src/protocol/errors.rs:5
  - core/src/protocol/errors.rs:68
status: open
---

## What

`agent/src/protocol/errors.rs` correctly re-exports the codes from core
(`pub use termihub_core::protocol::errors::*;`), but then **duplicates the entire `#[cfg(test)] mod
tests` block** from `core/src/protocol/errors.rs` verbatim — testing constants it does not own. The
copy has **already diverged**: core's `error_codes_are_negative` list includes
`TUNNEL_START_FAILED` (-32017) and `SERVICE_START_FAILED` (-32018), but the agent's copy of that
same test omits both.

## Why it matters

Low severity (it is test code), but it is a concrete, live example of the copy-paste-then-drift
failure mode this audit is about: the agent's test asserts against a stale subset of the codes and
would not notice a new code being added, giving false confidence. Re-testing re-exported constants
adds maintenance with no coverage value.

## Evidence

- `core/src/protocol/errors.rs:75-156` — the canonical test module, whose `error_codes_are_negative`
  array (lines 81-105) includes `TUNNEL_START_FAILED` and `SERVICE_START_FAILED`.
- `agent/src/protocol/errors.rs:5-84` — a near-identical copy; its `error_codes_are_negative` array
  (lines 11-33) stops at `DEFERRED_UPDATE_FAILED` and is missing the two newer codes.

## Recommendation

Delete the duplicated test module from `agent/src/protocol/errors.rs`. The codes are owned and
tested in core; the agent's `pub use` needs no re-test. If the agent wants a smoke check that the
re-export compiles, one trivial `use`-assertion suffices.
