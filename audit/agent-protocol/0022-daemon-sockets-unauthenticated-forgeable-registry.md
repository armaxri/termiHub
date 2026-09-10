---
id: AGT-022
title: Daemon and registry sockets have no authentication and no peer-credential check — any same-user process can hijack sessions or forge update broadcasts
angle: agent-protocol
severity: medium
category: security
is_workaround: false
subsystem: agent/src/daemon, agent/src/registry_daemon
evidence:
  - agent/src/registry_daemon/process.rs:236
  - agent/src/daemon/process.rs:194
  - agent/src/registry_daemon/client.rs:224
status: open
---

## What
Neither daemon socket authenticates its peer. There is no token, no nonce, and no
`SO_PEERCRED`/`getpeereid` peer-credential check anywhere in `agent/src` or `core/src/ipc`.
Any process that can `connect()` to the endpoint is fully trusted:
- **Session daemon:** a connector can inject input, read all PTY output/scrollback, resize,
  detach, or kill the session (`agent/src/daemon/process.rs:194`).
- **Registry daemon:** `handle_frame` (`agent/src/registry_daemon/process.rs:236`) trusts
  every self-reported field, including `pid`, and fans out broadcasts verbatim. Since the
  registry carries `agent.update_pending` — the coordinated binary-swap signal
  (`agent/src/registry_daemon/client.rs:224`) — a malicious same-user process can forge an
  `agent.update_pending` broadcast to every desktop on the host, or register spoofed clients,
  or (with AGT-020's weaknesses) contend for the endpoint.

The entire security of the persistent-session and coordination layer therefore rests on the
filesystem-perms boundary alone (AGT-020), with no defense in depth.

## Why it matters
"Same-user trust" is a common and often acceptable model, but here that boundary is the
*only* control and it is weakened by AGT-020, and the forgeable `pid` is used for debugging
attribution while being trivially spoofable. On a multi-tenant or compromised host the blast
radius (session hijack, forged host-wide update signals) is significant for a safety-critical
product.

## Evidence
- No `PEERCRED|peer_cred|getpeereid|ucred` anywhere in `agent/src`/`core/src/ipc`.
- `agent/src/registry_daemon/process.rs:236-295` — all record fields trusted, broadcast
  verbatim.
- `agent/src/registry_daemon/client.rs:224-232` — registry relays `agent.update_pending`.

## Recommendation
Add a `SO_PEERCRED`/`getpeereid` (unix) and token/SID (Windows) peer check on accept, and
reject a peer whose uid/SID does not match the agent user. Do not trust the self-reported
`pid`; derive it from the peer credential. Consider a per-instance handshake secret for the
registry so `agent.update_pending` cannot be forged by an arbitrary local process.
