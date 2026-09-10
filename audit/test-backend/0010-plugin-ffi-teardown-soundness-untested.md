---
id: TBE-010
title: Plugin FFI teardown/drop-order soundness has no test; use-after-free on unload is invisible
angle: test-backend
severity: high
category: test-gap
is_workaround: false
subsystem: core/plugin/host
evidence:
  - core/src/plugin/host.rs:145
  - core/src/plugin/host.rs:215
  - core/src/plugin/host.rs:689
  - core/tests/plugin_host_roundtrip.rs:73
status: open
---

## What
`LoadedLibrary`'s soundness rests on a drop-order invariant documented at host.rs:145-156: the
`library` field must be dropped **last** so `Drop` (host.rs:215-222) can call the plugin's
`shutdown()` while the library is still mapped, and so any live `LoadedBackend`/connection holding
resolved function pointers into that library outlives it. **No test exercises this.** The
`#[cfg(test)]` module (host.rs:689-933) covers permission gating, id disambiguation, symbol-name
parsing, missing-library, and ABI mismatch — all *load-time* concerns. The only teardown exercise
anywhere is `plugin_host_roundtrip.rs:73` doing a single `conn.disconnect()` on the happy path.

## Why it matters
A cross-expert finding reports a plugin FFI **use-after-free on teardown**. That is precisely the
class this test module cannot see: there is no test that (a) drops a library while a connection
into it is still alive, (b) reloads/replaces a plugin, or (c) tears down concurrently with an
in-flight backend call. `catch_unwind` in `Drop` (host.rs:221) contains a *panic* but does nothing
about a UAF, and a UAF only manifests under ASAN/Miri or as a nondeterministic crash — neither of
which any current test or CI lane runs for this crate.

## Evidence
- host.rs:145-156 — "**Must be the last field**" drop-order invariant, unenforced by any test.
- host.rs:215-222 — `Drop` calls `shutdown()` via `catch_unwind` (panic-safe, not memory-safe).
- host.rs:689-933 — 11 unit tests, all load-time; zero teardown/lifecycle tests.
- plugin_host_roundtrip.rs — connect→invoke→disconnect happy path only; no unload-while-active.

## Recommendation
Add lifecycle tests against the fixture plugin: (1) drop the host while a connection is live and
assert no crash; (2) load→drop→reload the same library; (3) a teardown-during-active-call test.
Run the plugin crate's tests under **Miri** and/or an ASAN build in a nightly lane — FFI UAFs are
undetectable by ordinary `cargo test`. This path is `unsafe` FFI and must have a memory-safety net,
not just functional assertions.
