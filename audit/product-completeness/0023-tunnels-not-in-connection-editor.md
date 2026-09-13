---
id: PROD-023
title: SSH port-forwarding/tunnels cannot be attached to a connection in the connection editor
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: core/backends/ssh, src-tauri/src/tunnel
evidence:
  - core/src/backends/ssh/mod.rs:249
status: open
---

## What
Tunnels live in a separate subsystem/editor. The SSH connection editor has no
port-forwarding fields, so a user cannot define "when I open this host, auto-forward these
ports" as part of the connection.

## Why it matters
Per-connection forwarding rules (as in `~/.ssh/config` LocalForward/RemoteForward) are an
expected SSH-client feature. Users must manage tunnels as separate objects and remember to
start them, rather than binding them to the connection.

## Evidence
- `core/src/backends/ssh/mod.rs` `settings_schema` has no forwarding fields; tunnels are under `core/src/tunnel/` + `src-tauri/src/tunnel/`.

## Recommendation
Allow attaching one or more forwarding rules to an SSH connection definition that auto-start
with the session (the tunnel engine already supports auto-start/reconnect).
