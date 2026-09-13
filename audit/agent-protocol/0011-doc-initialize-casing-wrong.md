---
id: AGT-011
title: Protocol spec shows snake_case initialize params but the agent requires camelCase — a third-party client following the doc cannot connect
angle: agent-protocol
severity: medium
category: docs
is_workaround: false
subsystem: docs/remote-protocol.md, agent/src/protocol/methods.rs
evidence:
  - docs/remote-protocol.md:316
  - docs/remote-protocol.md:2416
  - agent/src/protocol/methods.rs:63
status: open
---

## What
The normative protocol spec documents the `initialize` request with snake_case params —
`protocol_version`, `client`, `client_version` (`docs/remote-protocol.md:316`, and every
example e.g. `:2416`, `:2450`). But the agent's `InitializeParams`
(`agent/src/protocol/methods.rs:63`) carries `#[serde(rename_all = "camelCase")]`, so it
requires `protocolVersion`, `clientVersion`, `agentSettings`, `externalConnectionFiles` on
the wire. The real termiHub desktop sends camelCase (correct), but anyone implementing a
client from the spec would send snake_case and get `-32602 Invalid params` on the very first
message.

Note the intra-handshake inconsistency this reveals: `InitializeParams` is camelCase while
`InitializeResult` (`methods.rs:91`) has no `rename_all` and is snake_case — the request and
response of the same method use different casing conventions. Several other DTOs are
snake_case (`FilesRenameParams`, network params) while others are camelCase, with no stated
rule.

## Why it matters
`docs/remote-protocol.md` is the published contract for the protocol (it even carries a
version and status). A spec that does not match the implementation is a real defect for any
third-party or future re-implementation, and the casing inconsistency across DTOs is exactly
the soil that grows the AGT-001/AGT-009 drift bugs.

## Evidence
- `docs/remote-protocol.md:316` — request example uses `protocol_version`/`client_version`.
- `agent/src/protocol/methods.rs:63` — `#[serde(rename_all = "camelCase")]` on
  `InitializeParams`.
- `agent/src/protocol/methods.rs:91` — `InitializeResult` has no `rename_all` (snake).

## Recommendation
Correct the spec examples to camelCase for `initialize`, and adopt one casing convention for
the whole protocol (or explicitly document, per message, which is used). Generating the doc
DTOs from the shared protocol crate (AGT-001) would keep spec and code in lockstep.
