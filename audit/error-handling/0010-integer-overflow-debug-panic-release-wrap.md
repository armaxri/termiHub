---
id: ERR-010
title: No overflow-checks in release — arithmetic that panics in tests silently wraps in shipped builds
angle: error-handling
severity: low
category: reliability
is_workaround: false
subsystem: Cargo.toml (profiles), core/src (as-casts / arithmetic)
evidence:
  - Cargo.toml:45
  - core/src/backends
status: open
---

## What
The workspace sets `[profile.dev] debug = 0` (`Cargo.toml:45`) but **defines no `overflow-checks` override**, so the defaults stand: integer overflow **panics in dev/test** (debug-assertions on) and **silently wraps in release** (`--release`, which is what ships). Combined with the lossy `as` truncations the backend-core audit flagged — `port as u16` wrapping (**CORE-006**), TFTP block-number truncation (**CORE-023**), coordinate/offset casts — this means:

- A boundary input that would **panic loudly in CI** (catching the bug) produces a **silently wrong value in the shipped binary** (a wrapped port, a truncated length, a wrong offset) that flows on as if valid.

The two failure modes are inconsistent by construction: the test build and the release build disagree about what overflow *does*.

## Why it matters
- **Tests can't catch what release does.** The very inputs most likely to overflow (huge counts, extreme dimensions, adversarial length prefixes) are the ones a ventilator-grade release must handle deterministically. Today the behaviour is "panic in the lane that never ships, wrap in the lane that does" — the worst split for confidence.
- Silent wraparound feeds the allocation and truncation issues in ERR-009 / CORE-006 / CORE-023: a wrapped length or size is exactly how an "impossible" alloc or a mis-sized buffer arises.
- Low severity because no specific wrap is proven exploitable here, but it is a systemic hardening gap that makes every `as`-cast and arithmetic site quietly less safe in production than in test.

## Evidence
- `Cargo.toml:45` — `[profile.dev]` sets `debug = 0` but no `overflow-checks`; no `[profile.release]` override exists, so release keeps overflow-checks off.
- backend-core **CORE-006** (`port as u16`), **CORE-023** (TFTP block truncation) — concrete lossy casts that would benefit from release overflow-checks + explicit `try_into`.

## Recommendation
Turn on `overflow-checks = true` for `[profile.release]` (cheap for an interactive app; the perf cost is negligible next to PTY/network I/O), so release and test agree and an overflow becomes a controlled panic (containable per ERR-001) rather than silent corruption. Independently, replace hostile-input `as` truncations with checked `try_into()` returning a typed error (per CORE-006/023). This makes overflow a legible, uniform failure instead of a build-profile-dependent surprise.
</content>
