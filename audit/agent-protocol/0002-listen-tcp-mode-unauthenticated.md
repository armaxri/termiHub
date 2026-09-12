---
id: AGT-002
title: --listen TCP mode is fully unauthenticated and shares sessions across sequential clients
angle: agent-protocol
severity: high
category: security
is_workaround: false
subsystem: agent/src/io/tcp.rs
evidence:
  - agent/src/io/tcp.rs:25
  - agent/src/io/tcp.rs:96
  - agent/src/io/tcp.rs:126
  - agent/src/main.rs:155
status: open
---

## What
The agent's `--listen` mode binds a plain TCP socket (default `127.0.0.1:7685`) and serves
the **full JSON-RPC surface with no authentication whatsoever** — no token, no handshake
secret, nothing beyond `initialize`. Any local process or local user that can `connect()`
to the port gets to spawn shells, read/write arbitrary files as the agent user, run
network scans, open tunnels, host embedded servers, and trigger `agent.request_update`
(host-wide binary swap). Worse, the `SessionManager` is **shared across sequential
clients** (by design, for reconnect): when client A disconnects, its sessions are detached
but kept alive; the next client B to connect can `connection.list` + `connection.attach`
to A's sessions, read their buffered scrollback, and inject input.

## Why it matters
The documented deployment uses `--stdio` over SSH, and the Security Considerations section
leans entirely on SSH for auth ("The agent trusts any client that successfully
authenticates over SSH"). But `--listen` is a shipped, first-class mode (`--listen [addr]`
in `print_usage`, a full accept loop, its own registry wiring) with **zero** transport
auth. On a multi-user host, any unprivileged local user can drive the agent as the agent
user and hijack another user's live terminal sessions. Even bound to loopback, loopback is
not a security boundary on a shared host. For a safety-critical release this is a latent
privilege/session-hijack hole that ships in the binary regardless of whether the desktop
uses it.

## Evidence
- `agent/src/main.rs:155` — `--listen [addr]` accepts an arbitrary bind address from argv;
  nothing restricts it to loopback, so `--listen 0.0.0.0:7685` exposes it to the network.
- `agent/src/io/tcp.rs:96` — `TcpListener::bind(addr)` then `listener.accept()` with no
  auth step; the first message handled is `initialize`, which only negotiates a version.
- `agent/src/io/tcp.rs:34` / `:174` — `SessionManager` created once, `detach_all()` on
  disconnect (not close), so sessions persist for the next connector.
- `agent/src/io/tcp.rs:126` — stale notifications are drained on connect, but buffered
  ring-buffer output is explicitly "replayed on attach" — i.e. a new client sees prior
  output.

## Recommendation
Either (a) remove `--listen` from shipped builds if it is dev/test-only, gating it behind a
cargo feature, or (b) require an auth credential for TCP mode: bind loopback-only by
default, generate a per-instance token the launching process passes to clients, and require
it in `initialize` before any other method. Regardless, do not share `SessionManager`
across clients without an identity check that the reconnecting client owns the sessions it
attaches to. Document the exact threat boundary (which the current Threat Model table
omits — it lists only the SSH case).
