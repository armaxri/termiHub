---
id: CORE2-001
title: "Plugin connect/disconnect block a Tokio worker thread synchronously, for up to 30 s per connect, and ignore the cancel token"
angle: backend-core-rust
severity: medium
category: concurrency
is_workaround: false
subsystem: core/plugin (sandboxed runner session)
evidence:
  - core/src/plugin/connection.rs:335
  - core/src/plugin/connection.rs:345
  - core/src/plugin/connection.rs:349
  - core/src/plugin/connection.rs:366
  - core/src/plugin/sandbox/session.rs:78
  - core/src/plugin/sandbox/session.rs:183
  - core/src/plugin/sandbox/client.rs:39
  - core/src/plugin/sandbox/client.rs:46
  - core/src/plugin/sandbox/client.rs:417
  - core/src/plugin/sandbox/handle.rs:361
  - core/src/plugin/sandbox/handle.rs:371
  - core/src/connection/mod.rs:215
  - src-tauri/src/session/manager.rs:1151
  - src-tauri/src/session/manager.rs:1442
status: fixed
resolution: "#4323 — plugin connect/disconnect run on the blocking pool; connect_cancellable honours the token"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`PluginConnectionType::connect` is an `async fn`, but its body is fully blocking. `self.handle.acquire()` may respawn the runner while holding the handle's `current` mutex, then wait up to HELLO_TIMEOUT (5 s) for the runner's Hello and hash the pinned runner and library. `SandboxedSession::create` then parks the thread in `std::sync::mpsc::Receiver::recv_timeout(CREATE_TIMEOUT)`, which is 30 s, while the plugin's `create_backend` connects to its device. `disconnect` likewise blocks in `close()` -> `recv_timeout(REQUEST_TIMEOUT)` (2 s). The desktop awaits these on the Tauri Tokio runtime with no `spawn_blocking`/`block_in_place` (manager.rs:1151 `conn.connect_cancellable(...)`, manager.rs:1615 `disconnect().await`). The same manager does wrap the plugin's synchronous `write`/`resize` in `block_in_place` (manager.rs:1442/1483), so the blocking nature is known. Plugin connections also do not override `connect_cancellable`, so the default implementation drops the cancellation token.

## Why it matters

Each pending plugin connect pins one runtime worker for up to ~35 s. Concurrent acquires also serialise on the handle mutex, each holding its own worker while it waits. Restoring a workspace with several plugin tabs whose devices are slow or unreachable can tie up every worker of the multi-threaded runtime (one per core). That freezes every other async task in the desktop process: SSH/telnet output pumps, timers, IPC replies, file transfers. Cancelling a 'connecting' plugin tab (#952 semantics) also has no effect until the 30 s create deadline expires. This is the 'one slow plugin stalls the whole app' failure the out-of-process runner was meant to remove. Severity is medium because native plugins are default-off/experimental.

## Recommendation

Run the blocking parts off the async workers: wrap `acquire()` + `SandboxedSession::create` in `tokio::task::spawn_blocking` inside `connect`, moving owned clones of the config, settings, data_dir, output_tx and grant into the closure. Do the same for `backend.close()` in `disconnect` (or use `block_in_place`, as the manager already does for write/resize). Override `connect_cancellable` to race the spawn_blocking join against the token. On cancel, call `plugin.kill_for`/send `Close` for the pending session id so the runner side is torn down. Add a test that starts N > worker_threads plugin connects against a runner that never answers CreateSession and asserts that an unrelated `tokio::time::sleep` task still completes promptly.

## Verification

Confirmed. PluginConnectionType::connect (connection.rs:335-360) calls handle.acquire() and SandboxedSession::create synchronously. create blocks in reply.recv_timeout(CREATE_TIMEOUT), which is 30 s (client.rs:46, session.rs:78). disconnect calls backend.close(), which blocks in recv_timeout(REQUEST_TIMEOUT), 2 s (session.rs:183). The manager awaits conn.connect_cancellable (manager.rs:1151) and disconnect().await (manager.rs:1615) with no spawn_blocking or block_in_place, while write and resize are wrapped in block_in_place (manager.rs:1442/1483). The plugin type does not override connect_cancellable, so the default in connection/mod.rs:216 ignores the token. Worker starvation and a cancel that does nothing are both real. Medium fits because native plugins are opt-in.
