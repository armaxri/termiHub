---
id: OBS2-007
title: "Detached daemon stderr also goes to an unbounded per-session log that is deleted when the session ends"
angle: observability
severity: low
category: log-management
is_workaround: false
subsystem: "agent/src/daemon/transport.rs, agent/src/main.rs"
evidence:
  - agent/src/main.rs:192
  - agent/src/main.rs:193
  - agent/src/main.rs:283
  - agent/src/daemon/transport.rs:304
  - agent/src/daemon/transport.rs:317
  - agent/src/daemon/transport.rs:320
  - agent/src/daemon/transport.rs:261
  - agent/src/daemon/spawn.rs:29
  - agent/src/session/manager.rs:605
status: open
resolution: ""
audit: 2026-10
commit: "663465d52"
relation: new
---

## What

--daemon and --registry-daemon start with StderrLogFormat::Plain at RUST_LOG (default info) (main.rs:192-202, 283-286). Their stderr is redirected into session-<id>.log or registry.log in the socket dir, opened with File::create (transport.rs:304-321, spawn.rs:29). That file has no size cap or rotation and duplicates the rotating file sink. session-<id>.log is also removed together with the session's socket files (transport.rs:261), so daemon diagnostics are deleted at the moment a session dies.

## Why it matters

A persistent daemon that runs for weeks with a reconnect or error loop can grow session-<id>.log without limit in the runtime or temp dir, which goes against the bounded-on-disk design. The one copy that is easy to find near the failure disappears with the session, and combined with the shared-file rotation loss above, a dead daemon may leave no record anywhere.

## Recommendation

For detached roles, either set the stderr layer to WARN or raise only, so stderr just catches pre-tracing and stdlib output, or cap session-<id>.log, for example by truncating it when it passes 1 MiB or reusing RotatingLogFile with a per-session stem. Keep or rename the log on abnormal daemon exit instead of deleting it in remove_session_files.

## Verification

Mostly confirmed. open_log uses File::create with no cap or rotation, and detached daemons write plain stderr at the default info level into it, duplicating the rotating sink. remove_session_files deletes session-<id>.log. That deletion is a deliberate fix for leaked files and runs only once a session is known to be dead, so the 'deleted at death' part is a deliberate tradeoff. The unbounded-growth part still holds and is low severity.
