---
id: ERR-006
title: spawn_blocking join .expect() re-panics on the async side, amplifying blocking-path panics
angle: error-handling
severity: medium
category: reliability
is_workaround: true
subsystem: src-tauri/src/utils (ssh_auth, remote_exec)
evidence:
  - src-tauri/src/utils/ssh_auth.rs:122
  - src-tauri/src/utils/remote_exec.rs:618
status: fixed
resolution: "already-on-develop — production spawn_blocking join sites already return typed errors via map_err (session refactor: manager/remote_proxy/persistent_controller); remaining .expect sites are test-only (correct). No PR — verified 2026-09-12"
---

## What
Blocking SSH work is driven from async via `spawn_blocking`, and the join is unwrapped with `.expect("spawn_blocking join")`:

```rust
... .await.expect("spawn_blocking join");   // ssh_auth.rs:122, remote_exec.rs:618
```

`JoinHandle::await` returns `Err(JoinError)` when the blocking closure **panicked** (or was cancelled). `.expect()` on that turns a panic *inside* the blocking SSH auth/exec closure into a **second panic on the async task** driving the command — instead of converting it to a returned error. Combined with the ~232 poison-`unwrap()` sites inside those very SSH code paths (ERR-001), a panic in blocking auth/exec both (a) poisons any lock it held and (b) re-panics the command future via this `.expect()`.

## Why it matters
- **Panic amplification, not containment.** `spawn_blocking` is the natural place to *contain* a blocking-path panic (the runtime already caught it and handed you a `JoinError`); `.expect()` throws that safety away and propagates the crash into the command layer, where it rejects the `invoke` with an opaque message and leaves shared SSH/session state possibly poisoned.
- These are on the **connection hot path** (SSH authentication, remote command execution) — the operations most exposed to hostile/remote conditions (bad keys, malformed server responses, timeouts) that can trip an inner `unwrap`.
- The repo bans `.unwrap()`/`.expect()` on real paths; a join result that carries a real panic is a real path.

## Evidence
- `src-tauri/src/utils/ssh_auth.rs:122` — `.await.expect("spawn_blocking join")`.
- `src-tauri/src/utils/remote_exec.rs:618` — same.

## Recommendation
Map the `JoinError` to a typed error rather than re-panicking: `.await.map_err(|e| SessionError::SpawnFailed(format!("ssh auth task failed: {e}")))?` (or an `anyhow` context). This is where a blocking-side panic should become a clean, user-visible "authentication failed unexpectedly" rather than a cascading crash. Pairs with ERR-001 (stop the inner panics) and ERR-003 (return it typed). Mark `is_workaround` until fixed.
</content>
