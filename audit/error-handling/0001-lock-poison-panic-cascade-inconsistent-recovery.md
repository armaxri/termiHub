---
id: ERR-001
title: ~297 lock-poison unwrap/expect panic sites, applied backwards vs the new poison-recovering stores
angle: error-handling
severity: high
category: reliability
is_workaround: true
subsystem: src-tauri/src (session, credential, connection), core/src, agent/src
evidence:
  - src-tauri/src/terminal/agent_manager.rs:958
  - src-tauri/src/agents_projection/store.rs:737
  - src-tauri/src/layout/store.rs:821
  - core/src/backends/vnc/mod.rs
status: fixed
resolution: "#2772+#2773 — poison-tolerant locks: session/credential/connection managers"
---

## What
The codebase has **two opposite policies for `std::sync` lock poisoning, and they are applied in the wrong places.**

- **New projection stores recover:** 29 sites use `self.inner.lock().unwrap_or_else(|e| e.into_inner())`, which survives a poisoned mutex and keeps serving (`agents_projection/store.rs:737`, `layout/store.rs:821`, `system_monitor_projection/store.rs:270`, `broadcast_projection/store.rs:307`, `file_browser_projection/store.rs:412`, `restore_cohort_projection/store.rs:305`, `terminal/agent_config_store.rs:88`, `terminal/agent_manager.rs:958/995`, `credential/os_keychain.rs:135`).
- **Old core managers panic:** ~297 `.(lock|read|write)().(unwrap|expect)()` sites across `src-tauri/src` (212), `core/src` (52) and `agent/src` (33) — concentrated in `session/`, `credential/`, and `connection/` per the backend-tauri audit — take down whatever calls them the instant the lock is poisoned.

Because Rust poisons a mutex when a thread panics **while holding the guard**, the first panic anywhere under a lock converts every *subsequent* `lock().unwrap()` on that mutex into a panic too: a **poison cascade**. The subsystems that panic are exactly the safety-relevant ones (live sessions, credential store, connection registry), while the cosmetic projection mirrors are the ones that recover. That is backwards for a ventilator-grade bar.

There is **no `panic = "abort"`** (panics unwind — good, one panic won't `abort()` the whole process by default), but there is also **no global panic hook, no telemetry, and no `catch_unwind` around Tauri command futures or spawned tasks** (the only `catch_unwind` in the tree wraps plugin FFI and one config test). So a poisoned-lock panic surfaces as a rejected `invoke` promise with an opaque message, or a silently dead background thread — with nothing logged to the user-visible LogViewer.

## Why it matters
- **Blast radius is a whole subsystem, not one operation.** Once `SessionManager`'s or the credential store's mutex is poisoned, *every* later session/credential command panics — the user sees a cascade of failed operations with no way back short of restarting the app. Data in flight (an unsaved buffer, an in-progress transfer) is at risk.
- **The recovery discipline exists and is proven** (`into_inner()` in the new stores) but was never back-ported to the core managers, so the fix is known and mechanical.
- Prior threads: `workaround-rust` WA-RS-006 characterises these as "defensible lock-poison `.expect()`"; `backend-tauri` theme #2 flags the same ~175 src-tauri sites. This finding unifies them and adds the **cross-cutting cascade + inconsistent-direction** read that neither captured: the problem is not any single unwrap, it is that the recovery policy is inverted relative to criticality.

## Evidence
- Recovery pattern (correct): `src-tauri/src/agents_projection/store.rs:737` — `self.inner.lock().unwrap_or_else(|e| e.into_inner())` (29 such sites).
- Panic pattern (on critical paths): 297 `.(lock|read|write)().(unwrap|expect)()` sites; `src-tauri/src` 212, `core/src` 52, `agent/src` 33.
- No panic hook / abort / task-level `catch_unwind`: `grep set_hook / catch_unwind` finds only `core/src/plugin/host.rs`, `core/src/plugin/capabilities.rs`, and a `connection/config.rs` test.

## Recommendation
1. Adopt one policy everywhere: replace `.lock().unwrap()`/`.expect()` on `std::sync` locks with `.unwrap_or_else(|e| e.into_inner())` (or a small `poison_recover()` helper / `parking_lot::Mutex`, which has no poisoning) across `session/`, `credential/`, `connection/`, and the core backends. The new stores already show the pattern.
2. Install a **global panic hook** that logs `panic::Location` + payload into the diagnostics/LogViewer channel (see ERR-008) so a background-thread or command panic is never silent.
3. Consider wrapping Tauri command dispatch (or at least the `spawn_blocking` closures — see ERR-006) in `catch_unwind` so a single panic returns a typed error instead of poisoning shared state.
</content>
