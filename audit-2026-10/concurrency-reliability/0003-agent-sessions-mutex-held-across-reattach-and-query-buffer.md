---
id: CONC2-003
title: "Agent SessionManager holds the per-agent sessions mutex across daemon detach/reconnect in reattach_held and across query_buffer"
angle: concurrency-reliability
severity: medium
category: bug
is_workaround: false
subsystem: agent/session/manager
audit: 2026-10
commit: 663465d52
relation: new
status: fixed
resolution: "#4286 — reattach/detach/buffer daemon I/O runs outside the sessions lock in a per-session turn; a removed or replaced session releases the new connection"
evidence:
  - agent/src/session/manager.rs:1769
  - agent/src/session/manager.rs:1779
  - agent/src/session/manager.rs:2424
  - agent/src/session/manager.rs:1264
  - agent/src/session/manager.rs:1271
  - agent/src/daemon/client.rs:456
  - agent/src/daemon/client.rs:461
  - agent/src/daemon/client.rs:478
  - agent/src/daemon/client.rs:498
  - agent/src/daemon/client.rs:773
  - agent/src/daemon/client.rs:38
  - agent/src/daemon/client.rs:391
  - agent/src/daemon/transport.rs:61
---

## What

`reattach_held` takes `self.sessions.lock().await` and keeps the guard while it awaits `attach_backend` → `DaemonClient::reconnect`. That covers `detach()` (reader stop up to 2 s, a timed write up to 10 s, and a release wait up to 5 s) and then up to `PLAIN_REATTACH_RETRIES` (3) calls to `connect_and_start_reader` in non-fast-fail mode (30 s CONNECT_TIMEOUT plus 15 s READY_TIMEOUT each). `get_buffer` likewise keeps the guard across `client.query_buffer()`: up to 10 s for the write and 10 s for the reply. This is the same lock-across-network/IPC pattern fixed for `create` in CONC-004 (three-phase create), but the attach and buffer paths were never covered.

## Why it matters

After every desktop reconnect, `reattach_after_reconnect` (#4017) re-attaches each hosted session through this path, and an explicit Reclaim / attach RPC uses it too. If one session's daemon is wedged or slow (accepts but never sends ready), every other session on that agent freezes for tens of seconds up to a few minutes: input, resize, list, close and create all wait on the lock. That happens on the reconnect hot path, exactly when users are watching for recovery.

## Recommendation

Apply the CONC-004 pattern. Under a short lock, mark the session as attaching and take its `DaemonClient` out of the map (or put the client behind its own per-session `Arc<tokio::Mutex<DaemonClient>>`), then release the map lock before `attach`/`take_over`/`query_buffer`. Re-acquire the lock to store the result and the `attached` flag, and check that the session was not closed meanwhile. Add a deadlock test like `concurrent_mixed_ops_do_not_deadlock`: a stub daemon that never sends ready must not block `list`/`write` on another session.

## Verification

Confirmed. reattach_held (manager.rs:1769-1779) keeps the `sessions` guard while it awaits attach_backend, which calls DaemonClient::reconnect. That runs detach (2 s reader-stop bound, a timed write, 5 s release wait) and then connect_and_start_reader with fast_fail=false (30 s CONNECT_TIMEOUT plus 15 s READY_TIMEOUT). get_buffer (1264-1271) also keeps the guard across query_buffer: a timed write plus a 10 s reply wait. The retry loop only repeats on an OwnedByLivePeer refusal, a fast 150 ms path, so the worst case is about 1 minute per wedged session rather than several minutes. No ADR or audit note covers this. CONC-004 fixed only the create path, and audit item 0013 deals with the writer lock, not the sessions map. The attach RPC (desktop re-attach after reconnect, #4017) and reclaim both go through this path.
