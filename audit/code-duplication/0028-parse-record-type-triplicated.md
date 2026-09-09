---
id: DUP-028
title: DNS parse_record_type (string → DnsRecordType) is copy-pasted three times
angle: code-duplication
severity: low
category: arch
is_workaround: false
subsystem: core/tool, agent/network, src-tauri/commands
evidence:
  - core/src/tool/network_tools.rs:272
  - agent/src/network/mod.rs:117
  - src-tauri/src/commands/network.rs:746
status: open
---

## What

The identical 10-arm uppercase match from a DNS-record-type string to `DnsRecordType` is copied in
three places, differing only in the error type returned (`ToolError` / `anyhow::Error` /
`TerminalError`). Core already owns the enum and its `to_hickory_type`/`record_type_from_hickory`
mapping, but has **no** string parser — so each caller wrote its own.

## Why it matters

Low, but adding a record type requires editing three sites plus core's hickory mapping. A typical
copy-paste-drift trap.

## Evidence

- `core/src/tool/network_tools.rs:272-289` (→ `ToolError`).
- `agent/src/network/mod.rs:117-131` (→ `anyhow::Error`).
- `src-tauri/src/commands/network.rs:746-762` (→ `TerminalError`).
- `core/src/network/dns.rs:94-122` — the enum↔hickory mapping (no string parser).

## Recommendation

Add `impl FromStr for DnsRecordType` (or `DnsRecordType::parse`) in `core/src/network/types.rs`;
each caller maps the resulting error into its own type. Naturally subsumed if DUP-027 consolidates
the wrappers.
