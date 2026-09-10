---
id: CONC-004
title: Agent SessionManager::create holds the sessions mutex across daemon spawn + connect
angle: concurrency-reliability
severity: high
category: reliability
is_workaround: false
subsystem: agent/session/manager
evidence:
  - agent/src/session/manager.rs:485
  - agent/src/session/manager.rs:503
  - agent/src/session/manager.rs:511
  - agent/src/session/manager.rs:660
  - agent/src/session/manager.rs:671
  - agent/src/daemon/client.rs:97
status: open
---

## What

`SessionManager::create` acquires the `sessions` `tokio::sync::Mutex` up front
(`manager.rs:485`) and holds it across `create_backend(..).await` (`:503`), which for:

- **persistent** types spawns a daemon subprocess and calls `DaemonClient::connect` — a connect
  loop plus a `READY_TIMEOUT` of 15s (`daemon/client.rs:97`, spawn-path connect races the 30s
  window), and
- **in-process** types (e.g. an SSH session hosted on the agent) calls
  `connection.connect(settings).await` — a full SSH TCP connect + handshake (`manager.rs:671`).

It additionally nests `state.lock().await` (`:511`) while still holding `sessions`.

## Why it matters

The `sessions` mutex is the single gate for **all** session operations on the agent —
`write_input` (`:1270`), `resize` (`:1308`), `list` (`:700`), `attach`/`detach`/`close`
(`:717/754/799`), `active_count` (`:948`), and `recover_sessions`' insert (`:920`). Holding it for
the multi-second (up to ~30s+) duration of one session's connect means **one slow/hung
`connection.create` freezes input, resize, listing, and teardown for every other live session on
that agent**. Since an agent's whole value proposition is multiplexing many sessions, a single
unreachable host being opened stalls all the healthy sessions with it — a serialization cliff on
the exact path (session bring-up during/after reconnect) where responsiveness matters most.

Lock ordering here is `sessions → state`; other paths (`recover_sessions` at `:857`, the
close/attach paths) also take `sessions` before `state`, so there is no AB-BA inversion — but the
**hold duration** is the defect.

## Evidence

```rust
pub async fn create(&self, ...) -> Result<SessionSnapshot, SessionCreateError> {
    let mut sessions = self.sessions.lock().await;                 // :485  held for the whole fn
    ...
    let backend = self.create_backend(&id, type_id, &settings, capabilities.persistent)
        .await                                                     // :503-505  daemon spawn+connect / SSH handshake
        .map_err(...)?;
    if capabilities.persistent {
        if let SessionBackend::Daemon(ref client) = backend {
            let mut state = self.state.lock().await;               // :511  nested, still holding sessions
            ...
        }
    }
    sessions.insert(id, info);                                     // :541
```

## Recommendation

Do the expensive `create_backend` work **without** holding `sessions`: reserve the id (a quick
lock to check `MAX_SESSIONS` and insert a placeholder, or an atomic "pending" set), release the
lock, run the connect, then re-acquire briefly to insert the finished `SessionInfo`. This bounds
the `sessions` critical section to O(map-op) and lets other sessions' I/O proceed during a slow
connect. Add a test that a slow `create` (blocked backend connect) does not delay a concurrent
`write_input`/`list` on an existing session.
</content>
