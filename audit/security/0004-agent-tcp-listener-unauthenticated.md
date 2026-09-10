---
id: SEC-004
title: Agent TCP listener (`--listen`) has no application-layer authentication
angle: security
severity: high
category: security
is_workaround: false
subsystem: agent/src/io
evidence:
  - agent/src/io/tcp.rs:96
  - agent/src/io/tcp.rs:106
  - agent/src/main.rs:25
  - agent/src/main.rs:155
status: open
---

## What

In TCP listener mode (`termihub-agent --listen [addr]`, default
`127.0.0.1:7685`), the agent accepts a raw NDJSON JSON-RPC connection and runs the
**full `AgentHandler`** for any client that connects — with **no authentication,
no token, no handshake secret, and no transport encryption**. The accept loop
builds a handler and enters the transport loop immediately on connect:

```rust
// agent/src/io/tcp.rs:96-121
let listener = TcpListener::bind(addr).await?;
...
let (stream, peer) = match accept_result { Ok(conn) => conn, ... };
info!("Client connected from {}", peer);
// ... builds AgentHandler and runs run_transport_loop — no auth step
```
```rust
// agent/src/main.rs:25
const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:7685";
```

Whoever reaches the port can issue every JSON-RPC method the agent exposes:
spawn shell/SSH/Docker sessions, browse and read/write files, start tunnels and
embedded servers, run monitoring, and (if enabled) trigger self-update — i.e.
full control of the agent host with the agent's privileges.

## Why it matters

The documented/primary deployment reaches the agent over an SSH exec channel
(`--stdio`), where SSH provides authentication and encryption — that path is fine.
But the `--listen` TCP mode ships in the same binary and is exposed with zero
app-layer auth:

- **Default `127.0.0.1`** still means *any local process* — including local
  malware, a compromised browser, another user's process on a shared host, or a
  hostile container sharing the network namespace — can connect and drive the
  agent (session spawn, arbitrary file read) as the agent user. "localhost" is not
  an authentication boundary.
- **`--listen 0.0.0.0`** (an operator's reasonable reading of the flag, and what
  the tunnel/service docs imply is possible) exposes unauthenticated remote
  command execution to the LAN/Internet.

For a ventilator-grade device an unauthenticated control channel to a component
that can spawn shells is a critical exposure the moment the TCP mode is used.

## Evidence

- `agent/src/io/tcp.rs:96-171` — bind → accept → build handler → transport loop,
  no authentication anywhere in the path.
- `agent/src/main.rs:25`, `:155-172` — `--listen` with default `127.0.0.1:7685`,
  address taken verbatim from argv (can be `0.0.0.0`).
- `docs/remote-protocol.md` §Security notes the desktop "does not use" `--listen`,
  but the mode is fully implemented, unauthenticated, and reachable.

## Recommendation

Either (a) remove/feature-gate the `--listen` TCP mode out of release builds if
the desktop never uses it, or (b) require a shared-secret/token handshake before
any method other than a capability negotiation is dispatched (e.g. a
`bearer`-style token passed in `initialize`, compared in constant time, minted
per agent-launch and delivered over the SSH channel), and refuse a non-loopback
bind unless a token is set. Add mutual-TLS or an SSH-only transport if remote TCP
exposure is a real requirement. At minimum, document loudly that `--listen` is an
unauthenticated debug transport that must never be bound to a non-loopback address
and never used on a multi-tenant host.
