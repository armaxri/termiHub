---
id: TBE2-004
title: "Plugin library drop-order tests were removed with the in-process path; the runner's teardown is now untested"
angle: test-backend
severity: low
category: test-gap
is_workaround: false
subsystem: plugin-runner/runner + loader
evidence:
  - plugin-runner/src/runner/mod.rs:284
  - plugin-runner/src/runner/mod.rs:293
  - plugin-runner/src/runner/mod.rs:331
  - plugin-runner/src/runner/mod.rs:494
  - plugin-runner/src/runner/mod.rs:511
  - plugin-runner/src/loader/mod.rs:188
  - plugin-runner/src/loader/mod.rs:200
  - plugin-runner/src/loader/mod.rs:265
  - core/tests/plugin_runner_e2e.rs:96
  - core/tests/plugin_runner_e2e.rs:98
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: TBE-010
---

## What

The TBE-010 fix (#2968) added three host-side library-lifetime tests in core/src/plugin/host.rs: library_stays_mapped_until_the_last_arc_drops, unloading_one_library_leaves_another_untouched and host_unload_of_one_plugin_does_not_disturb_another. The sandbox cut-over (#4189) removed them together with the in-process load path, and commit 82737cdb6 then deleted `PluginLibrary::for_drop_order_test`.

The same safety-critical invariant now lives in the runner: `Server.library` is declared last so every `LoadedBackend` (raw vtable pointers into the mapped library) is closed and dropped before `plugin_shutdown`/unmap (runner/mod.rs:284-294, 494-509), and `PluginLibrary.library` must be its own last field (loader/mod.rs:188-206). plugin-runner/src/runner/mod.rs (545 lines) and loader/mod.rs (497 lines) have no unit tests. The only end-to-end teardown with a live session is `echo_backend_round_trips_through_the_runner`, which only checks that the runner pid disappears (plugin_runner_e2e.rs:96-105). A runner that segfaults during teardown (use-after-free after unmap) would still pass.

## Why it matters

The class TBE-010 was opened for, a use-after-free at FFI teardown, is again invisible to the suite. A reorder of `Server`'s fields, or a refactor that drops the library before draining sessions, would compile and pass every test. A crash during unload would also be misread as a clean shutdown.

## Recommendation

Assert a clean exit in the e2e unload: after `host.unload`, require the recorded exit cause/code to be the clean-shutdown one (exit code 0, not a signal). Add a unit test in plugin-runner that builds a `Server` around a stub `PluginLibrary` (restore a `#[cfg(test)]` constructor) and stub backends, runs `teardown()`, and checks that every backend's close/destroy is recorded before the stub `shutdown`, mirroring the removed host.rs tests. Optionally add a static check (or `memoffset`-style test comment) that `library` stays the last field of both structs.

## Verification

Confirmed: no library_stays_mapped/for_drop_order_test tests remain anywhere (82737cdb6 dropped the helper). runner/mod.rs has no test module. Server's `library` field is last only by comment (mod.rs:284-294). The e2e unload (plugin_runner_e2e.rs:96-102) only checks that the pid disappears, not a clean exit code, and runner_process.rs never tears down a loaded library with live sessions.

Downgraded to low: a teardown UAF now happens in an isolated, sandboxed runner process that is exiting anyway, so the host-side blast radius the original TBE-010 guarded against no longer exists. It is still a real gap.
