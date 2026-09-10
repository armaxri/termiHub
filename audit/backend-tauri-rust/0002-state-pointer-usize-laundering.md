---
id: TAURI-002
title: Managed-state pointers laundered through usize into spawned tasks
angle: backend-tauri-rust
severity: medium
category: workaround
is_workaround: true
subsystem: commands/network
evidence:
  - src-tauri/src/commands/network.rs:89
  - src-tauri/src/commands/network.rs:152
  - src-tauri/src/commands/network.rs:273
  - src-tauri/src/commands/network.rs:371
  - src-tauri/src/commands/network.rs:562
status: open
---

## What

Several network commands need to touch the `NetworkManager` from inside a `tokio::spawn`ed
`'static` task after the command returns. Because `State<'_, NetworkManager>` is borrowed for
the command's lifetime and cannot be moved into a `'static` future, the code defeats the
borrow checker by casting the reference to a raw pointer, then to `usize`, moving the integer
into the task, and casting back:

```rust
let manager_ref = manager.inner() as *const NetworkManager as usize;
tokio::spawn(async move {
    …
    // SAFETY: manager is Tauri managed state which outlives all tasks.
    let mgr = unsafe { &*(manager_ref as *const NetworkManager) };
    mgr.complete_task(&tid);
});
```

The `usize` round-trip specifically launders away the lifetime the borrow checker would
otherwise enforce. The soundness argument ("managed state outlives all tasks") is *usually*
true, but it is not guaranteed for the full app lifetime — managed state can in principle be
dropped on shutdown while a detached task is still in flight, and nothing here ties the task
to the state's liveness.

## Why it matters

This is a fragile, repeated `unsafe` pattern (5+ sites) that will silently become a
use-after-free if the assumption about state lifetime ever changes (e.g. per-window managed
state, teardown ordering changes). It is also a copy-paste template that invites more of the
same. Unlike TAURI-001 it is not currently UB, but it is exactly the kind of shortcut a
ventilator-grade review should convert to a checked pattern.

## Evidence

- `commands/network.rs:89` — `let manager_ref = manager.inner() as *const NetworkManager as usize;`
- `commands/network.rs:152,273,371,562` — `let mgr = unsafe { &*(manager_ref as *const NetworkManager) };`

## Recommendation

Make `NetworkManager` an `Arc`-managed state: `.manage(Arc::new(NetworkManager::new()))`, take
`State<'_, Arc<NetworkManager>>` in the commands, and `let manager = Arc::clone(&manager);`
before `tokio::spawn`. The `Arc` moves into the task safely, keeps the manager alive exactly
as long as any task needs it, and deletes every `unsafe` block here. This dovetails with the
TAURI-001 fix (constructing the manager inside `setup()` behind an `Arc`).
</content>
