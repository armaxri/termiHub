---
id: WA-RS2-004
title: "Poll loops stand in for events that already exist: monitoring sleep (3 copies), agent-reconnect cancel bridge, plugin stderr drain"
angle: workaround-rust
severity: low
category: poll-instead-of-event
is_workaround: true
subsystem: core/monitoring, core/backends/ssh/monitoring, src-tauri/agent_manager, core/plugin/sandbox
evidence:
  - core/src/monitoring/local_provider.rs:233
  - core/src/monitoring/local_provider.rs:238
  - core/src/monitoring/exec_provider.rs:359
  - core/src/monitoring/exec_provider.rs:364
  - core/src/backends/ssh/monitoring.rs:266
  - core/src/backends/ssh/monitoring.rs:271
  - core/src/monitoring/local_provider.rs:311
  - src-tauri/src/terminal/agent_manager/reconnect.rs:43
  - src-tauri/src/terminal/agent_manager/reconnect.rs:111
  - core/src/plugin/sandbox/peer.rs:445
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

WA-RS-001 (a poll loop where an event should be awaited) was fixed for the
embedded servers, but the same pattern remains elsewhere:

1. `interruptible_sleep` is copied verbatim in local_provider.rs, exec_provider.rs
   and ssh/monitoring.rs. It sleeps in 100 ms ticks and re-checks an
   `AtomicBool alive` plus `cancel.is_cancelled()`, although a
   `CancellationToken` is already in hand and supports `cancelled().await`.
   Paused monitors also poll `controls.is_paused()` every 200 ms
   (`PAUSE_POLL_INTERVAL`) instead of waiting on a notify.
2. The agent reconnect keeps a parallel `alive: AtomicBool` stop signal.
   `cancel_connect_when_disconnected` polls it every 100 ms to fire a
   `CancellationToken` (reconnect.rs:43-51), and the backoff wait again sleeps in
   100 ms slices re-checking the flag (reconnect.rs:108-120).
3. `Peer::finish` spins `thread::sleep(5ms)` on an `AtomicBool stderr_done` for
   up to 500 ms (peer.rs:445-448) instead of joining or waiting on a Condvar.

## Why it matters

Each stop signal is kept twice, as an AtomicBool and a token, which invites the
two drifting apart. Stop, resume and interval changes are delayed by up to one
tick. Every live or paused monitor and reconnect wakes 5-10 times a second for no
work. The triplicated helper means a fix must be applied three times. None of
this is a crash, but it is the workaround shape the first audit asked to remove.

## Recommendation

Make the `CancellationToken` the single stop signal. Have whatever clears `alive`
call `token.cancel()`, then replace `interruptible_sleep` with one shared helper:
`tokio::select! { _ = cancel.cancelled() => false, _ = tokio::time::sleep(delay) => true }`.
Put it in `core::monitoring` and reuse it in all three providers. Signal
pause/resume through a `tokio::sync::watch`/`Notify` from `MonitorControls`
instead of polling. In the agent reconnect, carry the token through
`disconnect_agent` so the bridge task and sliced sleeps disappear. In
`Peer::finish`, wait on a `Condvar` (or join the stderr thread with a timeout via
a channel `recv_timeout`) instead of spinning.

## Verification

Confirmed in all three places. (1) interruptible_sleep is duplicated verbatim in
local_provider.rs:233, exec_provider.rs:359 and ssh/monitoring.rs:266, using
100 ms ticks that check AtomicBool alive and cancel.is_cancelled(). The paused
loop polls via PAUSE_POLL_INTERVAL (local_provider.rs:311). (2) reconnect.rs:43-51
cancel_connect_when_disconnected polls alive every RECONNECT_CANCEL_POLL_INTERVAL
to fire a token, and the backoff loop (108-120) sleeps in 100 ms slices.
(3) peer.rs:445-448 spins with thread::sleep(5ms) on stderr_done up to
STDERR_DRAIN_TIMEOUT. All are functionally correct, add at most ~100 ms of
latency and cost little in wakeups, so low severity code quality and duplication.
