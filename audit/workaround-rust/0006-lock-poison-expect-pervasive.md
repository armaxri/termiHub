---
id: WA-RS-006
title: Pervasive lock-poison .expect()/.unwrap() on mutexes/rwlocks in production
angle: workaround-rust
severity: low
category: reliability
is_workaround: true
subsystem: core, src-tauri, agent (multiple)
evidence:
  - src-tauri/src/credential/master_password.rs:100
  - src-tauri/src/credential/manager.rs:70
  - core/src/backends/ssh/session_pool.rs:160
  - core/src/tool/mod.rs:113
  - src-tauri/src/session/ssh_trust_store.rs:119
  - src-tauri/src/session/rdp_trust_store.rs:115
  - src-tauri/src/session/ssh_host_key_verifier.rs:123
status: open
---

## What
Across the credential store, session pool, trust stores, host-key verifier and
tool host, `std::sync` locks are accessed with `.expect("... lock poisoned")` /
`.lock().unwrap()`. There are ~180 such sites in production paths (the bulk of
the raw "unwrap in production" count). Each panics if the lock is poisoned (a
thread panicked while holding it).

## Why it matters
This is a deliberate poison-propagation pattern (a poisoned credential/crypto
lock arguably *should* refuse to serve), so most are defensible. But it is a
blanket violation of the repo's stated "No `.unwrap()` in production code" rule,
and for the credential/master-password paths a poison-panic mid-operation could
crash the app rather than lock the store safely. It is worth a deliberate policy
decision before release rather than being left implicit.

## Recommendation
Decide the policy explicitly and document it: either (a) adopt `parking_lot`
locks (no poisoning, cleaner API) workspace-wide, or (b) keep `std::sync` but
centralize the poison handling in helper methods that recover the guard
(`.unwrap_or_else(|e| e.into_inner())`) or map to a fail-safe error, rather than
scattering `.expect()` at every call site. This lets the "no unwrap" rule stay
enforceable and makes the poison behavior a single reviewed decision.
