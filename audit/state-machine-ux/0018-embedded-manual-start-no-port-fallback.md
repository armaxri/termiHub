---
id: SM-018
title: Manual embedded-server Start lacks the port-fallback that quick-share already implements
angle: state-machine-ux
severity: low
category: bug
is_workaround: false
subsystem: src-tauri/src/commands/embedded_servers.rs
evidence:
  - src-tauri/src/commands/embedded_servers.rs:114
  - src-tauri/src/commands/embedded_servers.rs:136
  - src/store/slices/embedded-serversSlice.ts:143
status: open
---

## What
Manual Start from the sidebar is a plain passthrough (`commands/embedded_servers.rs:114-121`)
that errors if the port is busy, while `create_and_start_server` (`:136-172`) has a 10-port
fallback used **only** by `quickShareServer` (`embedded-serversSlice.ts:143-159`). Same
operation, two behaviors.

## Why it matters
Starting a server whose configured port is in use behaves inconsistently: quick-share silently
picks the next free port and succeeds, but sidebar Start just fails. The user gets different
outcomes for what is conceptually the same "start this server" action (old spec G5, still
present).

## Evidence
- `commands/embedded_servers.rs:114-121` — plain Start, no fallback.
- `commands/embedded_servers.rs:136-172` — the fallback logic quick-share uses.
- `embedded-serversSlice.ts:143-159` — quick-share calls the fallback path.

## Recommendation
Route both Start paths through the same port-fallback logic (or make the fallback a shared
option), so a busy configured port is handled consistently and surfaced to the user either
way.
