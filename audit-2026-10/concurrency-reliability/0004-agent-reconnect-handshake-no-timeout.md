---
id: CONC2-004
title: "Agent reconnect (and initial connect) handshake after SSH auth has no timeout, so a reconnect can hang forever in Reconnecting"
angle: concurrency-reliability
severity: medium
category: bug
is_workaround: false
subsystem: src-tauri/terminal/agent_manager/reconnect
audit: 2026-10
commit: 663465d52
relation: new
status: fixed
resolution: "#4304 — post-auth handshake (channel open, exec, initialize) bounded by AGENT_HANDSHAKE_TIMEOUT (45 s) on connect and per reconnect attempt, raced against the alive cancel token; timeout counts as a failed attempt"
evidence:
  - src-tauri/src/terminal/agent_manager/reconnect.rs:163
  - src-tauri/src/terminal/agent_manager/reconnect.rs:177
  - src-tauri/src/terminal/agent_manager/reconnect.rs:219
  - src-tauri/src/terminal/agent_manager/reconnect.rs:250
  - src-tauri/src/terminal/agent_manager.rs:3029
  - src-tauri/src/terminal/agent_manager.rs:3040
  - src-tauri/src/terminal/agent_manager/io_task.rs:740
---

## What

Only step 1 of `reconnect_agent`, the SSH connect, is bounded (45 s) and cancellable on `alive` (CONC-002). Steps 2-3 are plain awaits with no timeout and no check of `alive`: `channel_open_session().await`, `channel.exec().await`, `channel.data().await`, and the `read_handshake_line` loop, which is a bare `channel.wait().await`. `MAX_PRE_INIT_MESSAGES` caps how many messages arrive before `initialize`, not how long the wait takes. The initial `connect_agent` handshake (agent_manager.rs:1075-1140) has the same gap.

## Why it matters

If the SSH transport comes back but the agent never answers `initialize`, the I/O task waits forever and never fails the attempt. The agent may be stuck at start-up on session recovery, a single-instance lock, a mid-update binary, or a shell wrapper waiting for input. Because the attempt never fails, the backoff budget is never used up and `fold_agent_hosted_reconnect_failed` (io_task.rs:740) never runs. Hosted tabs stay `Reconnecting` with no terminal outcome, the stuck-reconnecting class that SM-001 and #2491 set out to remove. Only a manual Disconnect (via the CONC-009 abort) gets out of it.

## Recommendation

Wrap steps 2-3 of each attempt (channel open, exec, initialize write and response loop) in one `tokio::time::timeout` (for example 30 s), raced against the existing `alive`-driven cancel token. On timeout, count the attempt as a `ReconnectEvent::Failure` so backoff and give-up proceed. Apply the same bound to the initial connect handshake. Add a russh test with a fake agent that execs but never answers, and check that the reconnect gives up and folds the hosted tabs `Failed`.

## Verification

Confirmed. In reconnect.rs, only step 1 (connect_and_authenticate_cancellable) is bounded and cancellable. channel_open_session, exec, data and the read_handshake_line loop are plain awaits; read_handshake_line (agent_manager.rs:3029-3040) loops on channel.wait().await with no timeout, and MAX_PRE_INIT_MESSAGES caps the message count, not the time. SSH keepalives keep the transport alive, so an agent that never answers initialize parks the attempt indefinitely: no Failure event, no backoff, no give-up, and no Failed fold. Only Disconnect (the CONC-009 abort) gets out. The initial connect_agent handshake has no timeout either, but a user Cancel can stop it (run_connect_cancellable), so the reconnect path is the real problem. Medium is fair: the trigger, a hung agent start-up, is uncommon, but the outcome is the stuck-Reconnecting class.
