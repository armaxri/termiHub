---
id: DUP-002
title: JSON-RPC method names are string literals on both sides — no shared constant table
angle: code-duplication
severity: medium
category: arch
is_workaround: false
subsystem: agent/handler + protocol vs src-tauri/session, terminal, commands
evidence:
  - agent/src/handler/dispatch.rs
  - src-tauri/src/session/remote_proxy.rs:457
  - agent/src/session/agent_forward.rs:70
status: open
---

## What

The ~40 protocol method names (`"connection.create"`, `"session.attach"`, `"network.ping"`,
`"tunnel.start"`, `"service.start"`, `"agent.forward.data"`, …) are written as **bare string
literals** on both sides of the wire. The agent matches them in its dispatcher; the desktop passes
them into `send_request(...)`. Only a couple are ever declared as `pub const`
(`AGENT_UPDATE_PENDING`, `AGENT_UPDATE_AVAILABLE`, `AGENT_FORWARD_*`) and those live in the agent
crate, which the desktop does not depend on — so the desktop repeats the literal anyway.

## Why it matters

A typo or rename on one side is invisible to the compiler on the other and only fails at runtime
(unknown-method error), inside the CI-dark integration lane. It also makes the true method surface
impossible to enumerate from one place. Low blast radius per occurrence but a broad, standing
drift surface across every capability (session, files, network, tunnel, service, agent lifecycle).

## Evidence

- Agent dispatch literals (sampled): `"connection.attach"`, `"connection.write"`,
  `"connection.types"`, `"network.ping"`, `"monitoring.subscribe"`, `"tunnel.start"`,
  `"service.start"`, `"health.check"` — matched in `agent/src/handler/dispatch.rs`.
- Desktop literals for the same verbs: `src-tauri/src/session/remote_proxy.rs:457`
  (`"connection.types"`), and dozens more across `src-tauri/src/terminal/agent_manager.rs`,
  `src-tauri/src/network/agent_tools.rs`, `src-tauri/src/tunnel/tunnel_manager.rs`,
  `src-tauri/src/embedded_servers/server_manager.rs`.
- The `agent.forward.*` names ARE consts (`agent/src/session/agent_forward.rs:68-73`) but only in
  the agent; the desktop side re-types the literals.

## Recommendation

Define every method name once as `pub const` in the shared protocol home proposed in DUP-001
(`core::protocol::methods`). Both the agent dispatcher and the desktop client reference the
constants, so a rename is a single compiler-checked edit. Pairs with DUP-001 (the DTO structs) —
same shared crate.
