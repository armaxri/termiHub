---
id: ARCH2-001
title: "Backend reconnect redrive creates sessions without the saved-connection binding or transfer-resume trigger"
angle: architecture-overall
severity: medium
category: arch
is_workaround: false
subsystem: "src-tauri/src/session_projection/redrive.rs, src-tauri/src/commands/session.rs, src-tauri/src/session/retained_request.rs"
evidence:
  - src-tauri/src/commands/session.rs:163
  - src-tauri/src/commands/session.rs:170
  - src-tauri/src/commands/session.rs:179
  - src-tauri/src/session_projection/redrive.rs:167
  - src-tauri/src/session_projection/redrive.rs:195
  - src-tauri/src/session/retained_request.rs:57
  - src-tauri/src/session/manager/saved_connections.rs:19
  - src-tauri/src/files/transfer/relaunch_session.rs:161
  - src-tauri/src/commands/transfer.rs:283
  - src-tauri/src/session/persistent_controller.rs:91
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Two side effects of creating a session happen only in the `create_connection` Tauri command handler, after `SessionManager::create_connection` returns. The handler binds the session to its saved connection (`bind_saved_connection`, #3876) and fires the transfer auto-resume triggers (`relaunch_auto::spawn_resume_waiting` with `ConnectionOpened` / `AgentSessionOpened`, #3883/#4114). Since ADR-14, the backend redrive (`session_projection/redrive.rs:167`) is the only thing that reconnects a resilient tab. It calls `SessionManager::create_connection` directly, gets a new session id and gives it to the tab (line 195). It does neither of those two steps. `RetainedConnectionRequest` (retained_request.rs:57-80) does not even store the saved-connection id, so the redrive could not bind it if it tried. `persistent_controller.rs:91` takes the same unbound path.

## Why it matters

Auto-reconnect is on by default, so many SSH tabs end up on a session id that has no saved-connection binding. Two user-facing failures follow. (1) A transfer started after an auto-reconnect does not record its saved connection: `record_saved_connection` / `saved_connection_of` return None (relaunch_session.rs:161, transfer.rs:283). After a restart or session loss it cannot be relaunched, and its secret cannot be re-sourced. (2) Transfers that are paused waiting for that connection do not resume when the reconnect succeeds, and `sessions_for_saved_connection` does not find the reconnected session. The root cause is in the design: session-identity bookkeeping lives in one entry point (the IPC command) instead of in the session layer, so every other creation path quietly skips it.

## Recommendation

Move the saved-connection binding and the resume-trigger dispatch into the session layer. Either `SessionManager::create_connection` takes `saved_connection_id: Option<&str>` and does both on success, or a single `on_session_created` hook does it. Add `saved_connection_id` (and the agent definition id) to `RetainedConnectionRequest` so the redrive passes it through. Add a redrive test: after a redriven reconnect, `saved_connection_of(new_sid)` returns the connection, and a waiting transfer resumes.

## Verification

Confirmed. bind_saved_connection and both spawn_resume_waiting triggers are called only in the create_connection command handler (commands/session.rs:163-189). The redrive (redrive.rs:167) calls SessionManager::create_connection directly, and RetainedConnectionRequest has no saved_connection_id field. bind_saved_connection has no other caller. So a redriven SSH session id is unbound: saved_connection_of returns None for transfers started on it, and waiting transfers get no ConnectionOpened trigger. persistent_controller.rs:91 also creates the session without a binding. Auto-reconnect is on by default, so this is a real functional gap; medium fits.
