---
id: ARCH-011
title: NetworkManager is initialized by casting shared managed state from *const to *mut
angle: architecture-overall
severity: medium
category: workaround
is_workaround: true
subsystem: src-tauri/src/lib.rs, src-tauri/src/network
evidence:
  - src-tauri/src/lib.rs:576
status: open
---

## What

Tauri managed state is exposed as a shared reference (`State<'_, T>` /
`&T`). To perform post-registration initialization of `NetworkManager`, `setup()`
casts that shared reference to a mutable pointer and writes through it:

```rust
if let Some(net_mgr) = app.try_state::<NetworkManager>() {
    // SAFETY: NetworkManager is only initialised once at startup.
    let mgr_ptr = net_mgr.inner() as *const NetworkManager as *mut NetworkManager;
    unsafe { (*mgr_ptr).init(config_dir.clone(), app.handle().clone()) };
}
```
(`src-tauri/src/lib.rs:576-580`)

This mutates a value the runtime hands out as `&T` through a `*const → *mut`
cast. The "only initialised once at startup" comment is a hand-maintained
invariant, not something the type system enforces — nothing prevents another
`&NetworkManager` from existing at that instant, which is exactly the aliasing
condition that makes writing through the cast Undefined Behavior.

## Why it matters

- **`is_workaround`:** it exists to dodge the fact that the manager needs
  two-phase init (register, then initialize with `config_dir`/`AppHandle`) while
  Tauri only offers shared access. The correct pattern is interior mutability;
  the cast is a stopgap.
- On a memory-safety-marketed (Rust) ventilator-grade app, an `unsafe`
  const-to-mut write on shared state is precisely the class of hazard the
  "no `.unwrap()` / memory safety" standards exist to prevent — and it is on the
  startup path every launch runs.

## Evidence

- `src-tauri/src/lib.rs:576-580` — the `*const → *mut` cast and `unsafe` write.
- Every other manager in `setup()` is fully constructed before `app.manage(...)`
  (connection, tunnel, workspace, macro, …) — `NetworkManager` is the lone
  register-then-mutate outlier, confirming this is a shape mismatch, not a
  necessity.

## Recommendation

Give `NetworkManager` interior mutability for its late-bound fields
(`OnceCell`/`OnceLock` for `config_dir` + `AppHandle`, or a `Mutex`/`ArcSwap`
around the initializable part) and make `init(&self, …)` take `&self`. Then the
managed shared reference is sufficient and the `unsafe` cast is deleted. Or
construct it fully before `manage()` like every other manager (pass `config_dir`
+ handle into a constructor). Either removes the UB-adjacent cast entirely.
