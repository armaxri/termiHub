---
id: DOC-010
title: remote-protocol.md presents version negotiation/compat as enforced, but the desktop sends a stale hardcoded version and does no validation
angle: docs-accuracy
severity: medium
category: docs
is_workaround: false
subsystem: docs/remote-protocol
evidence:
  - docs/remote-protocol.md:255
  - docs/remote-protocol.md:265
  - src-tauri/src/terminal/agent_manager.rs:1752
  - src-tauri/src/terminal/agent_manager.rs:783
  - agent/src/handler/dispatch.rs:487
status: open
---

## What

`docs/remote-protocol.md` describes a two-sided version negotiation: "The desktop sends its
supported protocol version in the `initialize` request. The agent responds with the version it will
use", plus a compatibility matrix and "the agent MUST reject incompatible major versions" with a
`-32002 Version not supported` error. The **agent** side implements this faithfully. The **desktop**
side does not: it hardcodes a stale `protocolVersion: "0.3.0"` (protocol is now `0.8.0`) and never
validates the version the agent returns — it stores it for display only. The spec reads as
bidirectional enforcement; in reality the desktop neither advertises its real capability nor rejects
anything.

## Why it matters

The doc gives a false sense that the desktop is protected by version negotiation. In practice the
`-32002` / major-reject path is only reachable if the agent raises it; the current desktop can never
trigger a mismatch (it always sends major `0`), and it would happily proceed against an agent whose
returned version it doesn't understand. Anyone implementing a third-party client or reasoning about
forward/backward compat from this doc will be misled about where enforcement actually lives.

## Evidence

- Spec: `docs/remote-protocol.md:255` (negotiation description), `:260` "the agent MUST reject
  incompatible major versions", `:263` "selects the highest compatible version", `:267` compat matrix,
  `:382` `-32002 Version not supported`.
- Agent enforces (correct): `agent/src/handler/dispatch.rs:318-325` `negotiate_protocol_version`
  (major-mismatch → None), `:487-517` returns `-32002` on failure, `:602` echoes the negotiated (not
  hardcoded) version; `AGENT_PROTOCOL_VERSION = "0.8.0"` at `dispatch.rs:76`.
- Desktop does not: `src-tauri/src/terminal/agent_manager.rs:1752-1760` hardcodes
  `"protocolVersion": "0.3.0"` and `"clientVersion": "0.1.0"` (both stale); `agent_manager.rs:783-805`
  reads the returned `protocol_version` but performs no comparison/rejection (defaults to "unknown",
  stores for display).

## Recommendation

Either bring the desktop up to the spec (send its real supported version; validate the agent's
returned version and surface a clear error on major mismatch), or amend remote-protocol.md to state
plainly that enforcement is agent-side only and that the desktop currently advertises a fixed `0.3.0`
and does not reject on mismatch. Also fix the stale hardcoded `0.3.0`/`0.1.0` constants regardless —
they misreport the desktop's capability in the handshake and in the agent's connection registry.
