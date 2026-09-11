---
id: TAURI-001
title: NetworkManager initialised via &mut through a raw pointer cast from a shared State reference
angle: backend-tauri-rust
severity: high
category: bug
is_workaround: true
subsystem: network / lib.rs setup
evidence:
  - src-tauri/src/lib.rs:576
  - src-tauri/src/network/mod.rs:218
  - src-tauri/src/network/mod.rs:119
status: fixed
resolution: "#2761 — construct-then-manage; unsafe cast removed"
---

## What

`NetworkManager` is registered as Tauri managed state *before* the config dir is known
(`.manage(NetworkManager::new())` in the builder chain), then "initialised" inside
`setup()` by casting the shared `&NetworkManager` handed out by `State` to a `*mut` and
calling `init(&mut self, …)` through it:

```rust
if let Some(net_mgr) = app.try_state::<NetworkManager>() {
    // SAFETY: NetworkManager is only initialised once at startup.
    let mgr_ptr = net_mgr.inner() as *const NetworkManager as *mut NetworkManager;
    unsafe { (*mgr_ptr).init(config_dir.clone(), app.handle().clone()) };
}
```

`init` takes `&mut self` and writes `self.config_dir` (a plain `PathBuf`, **not** behind a
lock — `network/mod.rs:119`). So this fabricates a `&mut NetworkManager` aliasing the shared
reference `State` already handed out. That is undefined behaviour in Rust's aliasing model
regardless of the "only once at startup" argument: the `SAFETY` note addresses a data race
but not the aliasing/provenance rule, and there is no established happens-before between the
raw write and the later `&self` reads of `config_dir` from command threads.

## Why it matters

Undefined behaviour is a release blocker on principle for a safety-critical build: the
compiler is entitled to assume `&T` never aliases a live `&mut T`, and mis-optimisation of
the `config_dir` read/write is permitted. In practice today it "works", which is exactly why
it is dangerous — it will pass every test and can miscompile under a future toolchain or
LTO setting. `config_dir` feeds every HTTP-monitor / WoL persistence path, so a torn value
is a real (if unlikely) corruption vector.

## Evidence

- `lib.rs:576-580` — the `*const → *mut` cast and `unsafe { (*mgr_ptr).init(...) }`.
- `network/mod.rs:218` — `pub fn init(&mut self, config_dir: PathBuf, app_handle: AppHandle)`.
- `network/mod.rs:219` — `self.config_dir = config_dir.clone();` (the aliased write).
- `network/mod.rs:119` — `config_dir: PathBuf,` is a plain field, not interior-mutable
  (every other init target is a `Mutex`, hence init could otherwise take `&self`).

## Recommendation

Remove the `unsafe`. Two clean options:

1. **Construct fully, then manage.** Move `NetworkManager` construction out of the builder
   chain and into `setup()` after `config_dir` resolves, so it is built with the real dir and
   `.manage()`d already-initialised. This is the simplest and matches how the other managers
   (SessionManager, tunnel, workspace, …) are constructed inside `setup()`.
2. **Interior-mutable the one field.** Make `config_dir` a `OnceLock<PathBuf>` (or `Mutex`),
   change `init` to `&self`, and drop the pointer cast entirely.

Option 1 is preferred — it also lets `init`'s auto-start work happen with no separate step.
The same `usize`-pointer laundering in `commands/network.rs` (TAURI-002) then becomes an
`Arc<NetworkManager>` clone.
</content>
