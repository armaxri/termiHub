---
id: AGT-010
title: Protocol version negotiation is decorative — desktop pins 0.3.0, the major-check is meaningless for 0.x, and nothing gates on the negotiated version
angle: agent-protocol
severity: high
category: arch
is_workaround: false
subsystem: agent/src/handler/dispatch.rs, src-tauri/src/terminal/agent_manager.rs
evidence:
  - agent/src/handler/dispatch.rs:318
  - agent/src/handler/dispatch.rs:76
  - src-tauri/src/terminal/agent_manager.rs:1752
  - docs/remote-protocol.md:251
status: open
---

## What
The elaborate versioning apparatus in `docs/remote-protocol.md` (SemVer negotiation, a
compatibility matrix, "reject incompatible major") is effectively non-functional:

1. **Desktop pins an old version.** `build_initialize_params`
   (`src-tauri/src/terminal/agent_manager.rs:1752`) hardcodes
   `protocolVersion: "0.3.0"` while the agent is at `0.8.0` (`dispatch.rs:76`). Negotiation
   returns `min(0.3.0, 0.8.0) = "0.3.0"` for every connection, so the negotiated version is
   frozen at 0.3.0 regardless of what either side actually supports.

2. **The major-check is meaningless for 0.x.** `negotiate_protocol_version`
   (`dispatch.rs:318`) rejects only when `req.major != ag.major`. Every shipped version is
   `0.x`, so the major is always `0` and the check never fires. The doc's own matrix marks
   `0.1.0 ↔ 0.2.0` as **incompatible** ("connection.* not recognized" / "session.* removed"),
   but `negotiate_protocol_version("0.1.0","0.8.0")` returns `Some("0.1.0")` — it would
   declare a documented-incompatible pair compatible. The negotiation contradicts the spec
   it implements.

3. **Nothing gates on the negotiated value.** The agent registers *all* methods
   unconditionally; the desktop's `AgentConnection.protocol_version` field is
   `#[allow(dead_code)]` ("Stored for future protocol negotiation"). Feature/capability
   support is discovered purely by `-32601 Method not found` fallback, not by version. So
   the negotiated string is never read to enable/disable anything on either side.

## Why it matters
The protocol has no working forward/backward-compatibility mechanism. Because the app can
auto-update agents (AGT-003…008), app↔agent version skew is a real operational state, and
the only thing actually protecting it is "all methods always registered + method-not-found
fallback." That happens to work today, but it is undocumented-as-the-real-contract, and the
written spec (matrix, negotiation) gives false confidence. A future breaking change to a
`0.x` message shape would pass negotiation and then fail at runtime with a parse error
(exactly what AGT-001/009 already show for un-versioned drift).

## Evidence
- `src-tauri/src/terminal/agent_manager.rs:1752` — `protocolVersion: "0.3.0"` hardcoded.
- `agent/src/handler/dispatch.rs:318-325` — `negotiate_protocol_version`, only rejects on
  major mismatch (always equal for 0.x).
- `agent/src/handler/dispatch.rs:76` — `AGENT_PROTOCOL_VERSION = "0.8.0"`.
- `src-tauri/src/terminal/agent_manager.rs` — `protocol_version` stored `#[allow(dead_code)]`.

## Recommendation
Decide what the compatibility contract actually is and make it real. Options: (a) send the
desktop's true supported version and gate optional features on the negotiated result instead
of relying solely on method-not-found; (b) if method-not-found feature detection is the real
contract, document *that* as the contract and delete the misleading matrix; (c) when the
project reaches ≥1.0, ensure the major-check is meaningful, and until then use a
minor-based compatibility gate for `0.x` since 0.x minors can be breaking. At minimum, stop
pinning `0.3.0` and reconcile the negotiation logic with the documented matrix.
