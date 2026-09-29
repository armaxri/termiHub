# Backend `src-tauri` (Rust / Tauri) — audit summary

**Angle:** backend-tauri-rust · **Scope:** `src-tauri/src/**`, `capabilities/`, `tauri.conf.json`, `Cargo.toml`
**Auditor role:** senior Rust engineer, pre-release ("ventilator-grade") quality review of the desktop backend crate.
**Date:** 2026-09-10

## Overview

`src-tauri` is a large crate (~100k lines) that hosts the Tauri app, exposes ~270 IPC
commands, and implements the stateless-UI **projection** substrate. The engineering is,
on the whole, careful and heavily documented: errors are threaded with `?`, teardown is
explicit and per-OS-aware, recovery-on-load is pervasive (a corrupt config file degrades
rather than crashes), and the projection substrate core (`projection/`) is a genuinely
clean, well-tested, transport-neutral design with the right concurrency invariants
(snapshot-on-attach under one lock, single-writer intent dispatch, burst-coalescing diffs).

The risk is **not** sloppiness; it is **scale and a large in-flight architecture migration
shipping half-done**. Three themes dominate:

1. **A half-migrated projection architecture with dual authority.** 9 of 11 domains are
   "shadow": their backend store is registered, seeded at startup, and folded on *every*
   mutation, but nothing in the live UI renders from it — the frontend `appStore` stays
   authoritative. That means two authorities kept in sync by hand, and in several domains
   two writers into the same region (backend `fold_*` + frontend `*.replace` mirror). It is
   a lot of always-on machinery for behaviour that is not yet live, and a latent
   consistency hazard at cutover. Module docs describing this state may already be stale
   (project memory says the inversion is "done"), which is itself a maintainer trap.
2. **Panic-on-poison mutex handling on core paths.** ~175 production `lock()/read()/write()`
   sites `unwrap()`/`expect()` and will panic if the mutex is ever poisoned — concentrated
   in `session/` (68), `credential/` (33), `connection/` (31). One panic while holding a
   core lock cascades into every later access panicking. Notably the *new* projection
   stores deliberately recover via `into_inner()`; the *old* core managers do not. For a
   safety-critical release this inconsistency is the wrong way round.
3. **A handful of genuine `unsafe`/soundness shortcuts** to work around Tauri's `State`
   lifetime/ownership: a `&mut`-through-raw-pointer init of `NetworkManager`, `State`
   pointers laundered through `usize` into spawned tasks, and a multithreaded
   `env::set_var`. All "work today" but are undefined-behaviour-adjacent and removable.

Plus the expected large-codebase findings: a ~920-line god-`setup()`, several 2.5k–5.5k-line
modules against the repo's own ~500-line guideline, copy-pasted per-domain projection
boilerplate, and an inconsistent IPC error contract (`TerminalError` vs `String` vs bespoke
structs; `TerminalError` throws away its variant on the wire).

## Riskiest areas, ranked

1. **Projection migration is half-done and dual-authority (`*_projection/`, `lib.rs` setup).**
   The single biggest structural risk to ship in a safety-critical release. → TAURI-006, TAURI-007
2. **Mutex-poisoning cascading panics on session/credential/connection paths.** → TAURI-004
3. **`unsafe` shortcuts around Tauri `State` (NetworkManager `&mut` via raw ptr; `usize`
   pointer laundering; `env::set_var`).** → TAURI-001, TAURI-002, TAURI-003
4. **Silent partial credential migration on store switch (apparent credential loss).** → TAURI-011
5. **IPC error contract inconsistency (frontend can't branch on error kind).** → TAURI-008

## Findings index

| id | sev | title |
| --- | --- | --- |
| TAURI-001 | high | `NetworkManager` initialised via `&mut` through a raw pointer cast from a shared `State` reference (unsound aliasing) |
| TAURI-002 | medium | Managed-state pointers laundered through `usize` into spawned tasks (`commands/network.rs`) |
| TAURI-003 | medium | `unsafe std::env::set_var` during `setup()` after Tauri may have spawned threads |
| TAURI-004 | high | ~175 production `lock/read/write().unwrap()/expect()` panic on mutex poisoning (session/credential/connection) |
| TAURI-005 | medium | Startup `.expect()` on config-dir resolution panics the app instead of degrading |
| TAURI-006 | high | Half-migrated projection architecture: 9/11 domains shadow, dual authority + dual-write into shared regions |
| TAURI-007 | medium | Stale/misleading "shadow — not driving the live UI" module docs contradict the stated migration status |
| TAURI-008 | medium | Inconsistent IPC error contract (`TerminalError` vs `String` vs bespoke structs; variant lost on the wire) |
| TAURI-009 | low | God-`setup()` (~920 lines) and several 2.5k–5.5k-line modules exceed the repo's ~500-line guideline |
| TAURI-010 | low | Copy-pasted per-domain projection boilerplate across 10 domains (defer detail to duplication expert) |
| TAURI-011 | medium | `switch_credential_store` silently skips unreadable credentials → apparent credential loss on mode switch |
| TAURI-012 | low | No authorization on intents / shared-region subscribe (fine for desktop, risk in remote-client mode) |
| TAURI-013 | info | Single global dispatcher `write_lock` serialises every intent across all domains |
| TAURI-014 | low | Unbounded channels in agent forwarding / local-process output (no backpressure) |
</content>
</invoke>
