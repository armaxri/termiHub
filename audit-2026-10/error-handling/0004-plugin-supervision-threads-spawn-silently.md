---
id: ERR2-004
title: "Plugin watchdog, idle-reaper and bridge-pump threads fail to start silently, so the safety checks are quietly off"
angle: error-handling
severity: low
category: reliability
is_workaround: false
subsystem: "core/src/plugin/sandbox (watchdog, handle, proxy)"
evidence:
  - core/src/plugin/sandbox/watchdog.rs:103
  - core/src/plugin/sandbox/watchdog.rs:105
  - core/src/plugin/sandbox/handle.rs:451
  - core/src/plugin/sandbox/handle.rs:276
  - core/src/plugin/sandbox/proxy.rs:67
  - core/src/plugin/sandbox/proxy.rs:71
  - core/src/plugin/sandbox/client.rs:100
  - core/src/plugin/sandbox/client.rs:106
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
---

## What

Several threads are started with `let _ = std::thread::Builder::new()...spawn(..)`, which ignores a spawn failure:

- watchdog::spawn, which does hang detection and the memory-pressure kill (#4239).
- spawn_idle_reaper (handle.rs:451) and the crash-recovery follow-up (handle.rs:276).
- The bridge proxy's pump and writer threads (proxy.rs:67/71).
  If any of these fails to start, the plugin carries on with no watchdog, no idle reaping, or a bridged connection that never moves data. Nothing is logged.
  The same constructor treats a failed stderr-forwarder spawn as fatal: SandboxedPlugin::spawn kills the runner and returns HostError::RunnerProtocol("stderr thread") (client.rs:100-107). The reader thread is handled the same way.

## Why it matters

Thread creation fails mainly under resource exhaustion, which is exactly when a hung or memory-hungry plugin most needs the watchdog. As written, a sandboxed native plugin can lose its hang and OOM supervision without any trace. The handling is also inconsistent with the stderr and reader threads in the same constructor.

## Recommendation

1. Have watchdog::spawn return io::Result<()>. In SandboxedPlugin::spawn, treat its failure like the stderr-thread failure: kill the runner and return HostError::RunnerProtocol("watchdog thread").
2. For the proxy pump and writer threads, close the connection and send StreamClosed if either spawn fails.
3. For the idle reaper and recovery threads, at least log at error level.

## Verification

Confirmed. watchdog.rs:103, handle.rs:276, handle.rs:451 and proxy.rs:67/71 all use `let _ = std::thread::Builder::new()...spawn(..)`, while the stderr-thread spawn in the same constructor (client.rs:100-107) is fatal on failure. A failed watchdog spawn silently turns off hang and OOM supervision. Thread spawn failure is rare, so low.
