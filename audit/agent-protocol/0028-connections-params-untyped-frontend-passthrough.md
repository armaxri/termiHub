---
id: AGT-028
title: connections.* create/update params flow verbatim from frontend TypeScript through opaque Value pass-throughs to snake_case agent DTOs
angle: agent-protocol
severity: info
category: arch
is_workaround: false
subsystem: src-tauri/src/commands/agent.rs, agent/src/protocol/methods.rs
evidence:
  - src-tauri/src/commands/agent.rs:478
  - agent/src/protocol/methods.rs:277
status: open
---

## What
`connections.create` / `connections.update` / `connections.folders.update` params are passed
**verbatim** from the frontend TypeScript through opaque `serde_json::Value` pass-throughs
(`src-tauri/src/commands/agent.rs:478` → `agent_manager.rs`) to the agent's snake_case
`ConnectionCreateParams` / `ConnectionUpdateParams` / `FolderUpdateParams` (no `rename_all`,
`agent/src/protocol/methods.rs:277`). The desktop Rust layer does no key validation or
reshaping, so any camelCase↔snake_case drift between the frontend and the agent is a contract
invisible to the Rust type system — the same untyped-hand-rebuild class that produced the
live AGT-001 and AGT-009 breaks, just moved one layer up (TS↔agent instead of desktop↔agent).

## Why it matters
It is not a confirmed bug (verifying requires the TS call sites, outside this audit's file
set), but it is the structural soil for silent wire drift on the connection-management verbs,
and it bypasses Rust's type checking entirely. Worth verifying against the frontend and worth
eliminating with a shared, typed contract.

## Evidence
- `src-tauri/src/commands/agent.rs:478-598` — `Value` pass-through, no reshaping.
- `agent/src/protocol/methods.rs:277` — snake_case `ConnectionCreateParams` (no `rename_all`).

## Recommendation
Type these params on the desktop side (deserialize into a shared DTO, re-serialize) so drift
is a compile error, and add a TS↔agent contract test. Fold into the shared-protocol-crate work
(AGT-001).
