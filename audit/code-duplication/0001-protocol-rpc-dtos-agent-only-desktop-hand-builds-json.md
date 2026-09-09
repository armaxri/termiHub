---
id: DUP-001
title: Centralize JSON-RPC request/response DTOs — defined only in agent, desktop rebuilds them as hand-written JSON
angle: code-duplication
severity: high
category: arch
is_workaround: false
subsystem: agent/protocol vs src-tauri/session (remote_proxy, agent_manager)
evidence:
  - agent/src/protocol/methods.rs:31
  - agent/src/protocol/methods.rs:148
  - agent/src/protocol/methods.rs:360
  - src-tauri/src/session/remote_proxy.rs:457
  - src-tauri/src/session/remote_proxy.rs:542
  - src-tauri/Cargo.toml:87
status: open
---

## What

Every desktop↔agent JSON-RPC request/response payload is modeled by a `#[derive(Serialize,
Deserialize)]` struct in **`agent/src/protocol/methods.rs`** (≈70 structs/enums:
`SessionCreateParams`, `FilesListResult`, `NetworkPingResponse`, `MonitoringData`,
`TunnelStartParams`, `ServiceStartResult`, …). The **desktop is not built against the agent
crate** (`src-tauri/Cargo.toml` depends on `termihub-core` but never on `termihub-agent`), so it
cannot use these types. Instead it constructs every outgoing request and parses every response
**by hand** with `serde_json::json!({...})` and `Value` indexing.

There is therefore **no single source of truth for the wire protocol**: the struct in the agent and
the hand-built JSON on the desktop are two independent definitions of the same message that are
kept compatible only by human diligence.

## Why it matters

This is the single largest app↔agent divergence hazard in the codebase. The two sides of a
safety-relevant transport are defined twice, with the compiler unable to see the relationship:

- Renaming/adding a field in an agent `*Params`/`*Result` struct does **not** cause any desktop
  compile error; the mismatch surfaces only at runtime as a dropped field or a failed parse.
- The only automated coverage of the round-trip is the agent integration test lane, which is
  **dark in per-PR CI** (`-m "not integration"`, per the repo's known gap) — so a drift ships
  green.
- The desktop already accretes hand-parsers for the wire shape (`parse_agent_definition`,
  `parse_agent_folder`, `parse_agent_session_info…` in `agent_manager.rs`), duplicating fields the
  agent struct already names.

## Evidence

- `agent/src/protocol/methods.rs:31` onward — the full DTO catalog (`AgentSettings`,
  `InitializeParams`, `SessionCreateParams:148`, `FilesListParams/Result:360`,
  `Network*Params/Response:545`, `MonitoringData:648`, `Tunnel*:702`, `Service*:790`).
- `src-tauri/Cargo.toml:87` — desktop deps: `termihub-core` only; no `termihub-agent`.
- `src-tauri/src/session/remote_proxy.rs:457,542,560,576,589,601,615,628,694,724` — requests built
  as `serde_json::json!({...})` rather than by serializing a shared struct.
- Response parsing on the desktop is likewise hand-rolled (`agent_manager.rs` `parse_agent_*`
  helpers), re-deriving the same field names the agent struct declares.

## Recommendation

Move the protocol DTOs to a shared home both crates already depend on: a new
`core::protocol::methods` (or a dedicated `termihub-protocol` crate). Define each `*Params`/
`*Result`/notification struct **once** there; have the agent `pub use` them (as it already does for
`core::protocol::errors`/`messages`) and have the desktop serialize/deserialize those same structs
instead of building `Value`s by hand. This makes any protocol change a single edit the compiler
enforces on both sides. Pairs with DUP-002 (method-name constants) and DUP-010 (Tunnel
`TunnelType`⇄`TunnelForwardSpec` hand-poked JSON), which are the same root cause.
