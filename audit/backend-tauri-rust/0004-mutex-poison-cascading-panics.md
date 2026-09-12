---
id: TAURI-004
title: ~175 production lock/read/write().unwrap()/expect() panic on mutex poisoning
angle: backend-tauri-rust
severity: high
category: reliability
is_workaround: false
subsystem: session / credential / connection
evidence:
  - src-tauri/src/credential/master_password.rs:100
  - src-tauri/src/credential/master_password.rs:112
  - src-tauri/src/session/manager.rs
  - src-tauri/src/connection/manager.rs
  - src-tauri/src/projection/mod.rs:315
status: fixed
resolution: "#2772+#2773 — poison-tolerant locks across the 3 old managers"
---

## What

~175 production (non-test) sites acquire a `Mutex`/`RwLock` with `.lock()/.read()/.write()`
followed by `.unwrap()` or `.expect("… lock poisoned")`. If the lock is ever *poisoned* — i.e.
some thread panicked while holding it — every subsequent acquisition panics too. Distribution
by area (production files only):

- `session/` — 68
- `credential/` — 33
- `connection/` — 31
- `terminal/xserver/` — 24, `terminal/` — 17, rest — ~2 each

The credential store is the sharpest example: `credential/master_password.rs` guards the salt,
derived key, KDF cost, and the decrypted credential map each behind a `RwLock` and does
`.write().expect("… lock poisoned")` / `.read().expect(…)` on every operation. A single panic
anywhere under one of those guards permanently bricks credential access for the rest of the
process — every unlock/resolve/store call then panics.

Crucially the pattern is **inconsistent within the crate**: the newer projection code
deliberately *recovers* from poison —

```rust
// projection/mod.rs:315
fn lock(&self) -> MutexGuard<'_, …> {
    self.regions.lock().unwrap_or_else(|e| e.into_inner())
}
```

— and the `*_projection/store.rs` modules do the same. The older core managers
(session/credential/connection) do not. For a safety-critical release the resilient policy is
applied to the *new, not-yet-live* code and the panic policy to the *old, core* code — the
wrong way round.

## Why it matters

Mutex poisoning turns one localized panic into a cascading, unrecoverable failure of a whole
subsystem (sessions, or credentials, or the saved-connection tree). On a ventilator-grade bar,
"one bug anywhere under this lock kills all future credential operations" is a reliability
defect, not just style. The blast radius is largest exactly where it is worst: credentials and
live sessions.

## Evidence

- `credential/master_password.rs:100,104,108,112,202,…` — `.write().expect("… lock poisoned")`
  on every mutating op; `:260,269,278,341,398,456,…` — `.read().expect(…)` on every read.
- `credential/os_keychain.rs:55` — `.expect("OS keychain entry cache lock poisoned")`.
- `session/manager.rs`, `connection/manager.rs` — 68 and 31 `lock().unwrap()` sites respectively.
- Contrast: `projection/mod.rs:315`, `agents_projection/store.rs`,
  `session_projection/store.rs`, etc. all use `unwrap_or_else(|e| e.into_inner())`.

## Recommendation

Adopt one poison policy crate-wide, and make it *recover* on the core paths:

1. Add a small helper (or extension trait) `fn guard(&self) -> Guard { m.lock().unwrap_or_else(|e| e.into_inner()) }`
   and route session/credential/connection/terminal lock acquisitions through it, matching what
   `projection` already does.
2. Where a poisoned lock genuinely means the data is unsafe to trust (e.g. a half-written
   credential map), surface a typed error to the caller rather than panicking — the credential
   commands already return `Result`, so a `PoisonRecovered`/`Corrupt` path can degrade to
   "store unavailable, please retry/restart" instead of aborting the process.
3. Audit that no code panics *while holding* these locks in the first place (that is what
   poisons them) — the recovery helper is defense-in-depth, not a substitute.
</content>
