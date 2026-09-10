---
id: AGT-020
title: Daemon sockets live in a predictable /tmp path with unverified parent ownership, and identity comes from the spoofable USER env with an "unknown" fallback
angle: agent-protocol
severity: medium
category: security
is_workaround: false
subsystem: agent/src/daemon/transport.rs, core/src/ipc/local_socket.rs
evidence:
  - agent/src/daemon/transport.rs:229
  - agent/src/daemon/transport.rs:230
  - core/src/ipc/local_socket.rs:211
status: open
---

## What
The only access gate on the session/registry daemon sockets is filesystem permissions (there
is no auth token — see AGT-022). Two weaknesses undermine that gate:

1. **Predictable path, unverified parent (MEDIUM).** `socket_dir()` is
   `/tmp/termihub/<USER>` (`agent/src/daemon/transport.rs:229`). The parent
   `/tmp/termihub` is created with default (umask-dependent, typically world-traversable)
   perms and its ownership is never asserted (`core/src/ipc/local_socket.rs:211`); only the
   leaf `<USER>` dir is chmod'd `0o700`. An attacker who pre-creates
   `/tmp/termihub/<victim>` makes the victim's `set_permissions(0o700)` fail (non-owner
   cannot chmod) → `bind` fails → **local DoS** of the victim's persistent sessions and
   registry. `/tmp` is also not reliably cleared on macOS.

2. **Identity from a spoofable env var (MEDIUM edge case).** The per-user scoping key is the
   `USER`/`USERNAME` env var with a fixed `"unknown"` fallback
   (`agent/src/daemon/transport.rs:230`, `:326`). Two real users who both run with `USER`
   unset share `/tmp/termihub/unknown` / `\\.\pipe\termihub-registry-unknown`. On Windows the
   pipe name is the *only* per-user scoping (the `\\.\pipe\` namespace is machine-global), so
   the DACL is all that saves them. `USER` is trivially spoofable.

## Why it matters
Because there is no socket-level authentication, the perms boundary *is* the security model.
A predictable path with an unverified parent and a spoofable, collide-to-"unknown" identity
weakens exactly that boundary — enabling at least a clean local DoS and, in the `USER`-unset
edge case, cross-user endpoint collision that leans entirely on the DACL.

## Evidence
- `agent/src/daemon/transport.rs:229-232` — `/tmp/termihub/<USER>` path.
- `agent/src/daemon/transport.rs:230`, `:326` — `USER`/`USERNAME` → `"unknown"` fallback.
- `core/src/ipc/local_socket.rs:211-212` — parent created default-perms, only leaf chmod'd.

## Recommendation
Use `$XDG_RUNTIME_DIR` when set (already 0700, user-owned, auto-cleaned); otherwise create
the private dir and **verify** it is owned by the current uid and is not a symlink before
binding. Derive identity from `getuid()` / the token SID, never the `USER` env var, and never
fall back to a shared fixed name.
