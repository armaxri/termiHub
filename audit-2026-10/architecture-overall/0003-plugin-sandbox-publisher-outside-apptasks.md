---
id: ARCH2-003
title: "plugin-sandbox projection publisher is an untracked, uncancellable app-lifetime loop, outside the AppTasks contract"
angle: architecture-overall
severity: low
category: reliability
is_workaround: false
subsystem: "src-tauri/src/plugin_sandbox_projection"
evidence:
  - src-tauri/src/plugin_sandbox_projection/mod.rs:59
  - src-tauri/src/plugin_sandbox_projection/mod.rs:110
  - src-tauri/src/boot/mod.rs:1045
  - src-tauri/src/app_tasks.rs:9
  - src-tauri/src/lib.rs:308
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: ARCH-007
---

## What

`start_publisher` starts a raw `std::thread` running `loop { sleep(1s); publish(&app) }`, with no stop condition. It is not registered with `AppTasks` (no tracker token, no child cancellation token), even though app_tasks.rs:34-40 documents exactly that pattern for loops on dedicated threads. The ARCH-007 fix set an invariant: every app-lifetime loop goes through AppTasks, and every remaining bare spawn is session-, request- or stream-scoped. This loop, added in #4188, breaks it.

## Why it matters

Teardown (`run_app_teardown` → `AppTasks::shutdown`) can no longer claim that every owned background task has stopped. The thread keeps re-snapshotting the plugin host and publishing into the projector while the plugin host and the projection substrate are being torn down. The polling design also means an idle app wakes every second even with native plugins off (the default). It also sets a precedent of polling instead of push for a region whose changes have well-defined sources: crash, restart, reap, denial.

## Recommendation

Register the thread with AppTasks: take `tasks.tracker().token()` for the thread's lifetime, and exit when a child of `tasks.cancellation_token()` is cancelled. Better still, have PluginHost's runner and denial paths call a publish callback (an `Arc<dyn Fn()>` handed to the host at boot) and drop the 1 s poll. Skip starting it while native plugins are globally disabled.

## Verification

Confirmed. start_publisher (plugin_sandbox_projection/mod.rs:110-118) is a bare std::thread with an unconditional 1 s sleep/publish loop. It takes no AppTasks tracker token and no cancellation token, although app_tasks.rs:34-40 documents that contract for dedicated-thread loops. It is the only `spawn(move || loop` in src-tauri, it is started unconditionally from boot, and publish is a cheap no-op when nothing changed. Low is right.
