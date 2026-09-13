---
id: DUP-030
title: Rust↔TypeScript DTOs are hand-mirrored across the whole IPC surface (no codegen)
angle: code-duplication
severity: medium
category: reliability
is_workaround: false
subsystem: src/types/* + src/services/api.ts vs core + src-tauri Rust types
evidence:
  - src/types/connection.ts:698
  - core/src/files/mod.rs:16
  - src/types/embeddedServer.ts:2
  - src/services/api.ts:1197
status: open
---

## What

Every type crossing the Tauri IPC boundary is declared once in Rust and hand-re-declared in
TypeScript, kept in sync manually across the serde/camelCase boundary. This is a systemic,
cross-cutting duplication, not a single site. Representative mirrors:

- `FileEntry` — `core/src/files/mod.rs:16` ↔ `src/types/connection.ts:698`.
- `SavedConnection`/`ConnectionFolder` — `src-tauri/src/connection/config.rs` ↔
  `src/types/connection.ts:37/48` (also the agent, DUP-008).
- Embedded-server config/status — `core/src/embedded_servers/config.rs` ↔
  `src/types/embeddedServer.ts:2-41`, with TS-only constants (`DEFAULT_PORTS`, `PROTOCOL_LABELS`) that
  have no Rust counterpart.
- Transfer types — `src-tauri/src/files/transfer/*` ↔ `src/services/api.ts:1175-1226` +
  `src/types/connection.ts:19`.
- Tunnel, monitoring, network, workflow, spawn types — each has a `src/types/*.ts` mirror.

## Why it matters

Medium and pervasive. A renamed/added field or a camelCase mismatch silently breaks
decoding at runtime with no compiler or test signal (unless a hand-written test happens to cover
it). The additive #1336 transfer fields already show the drift pressure (many `Option`/`?` fields
kept in sync by hand). Some constants exist on only one side (`DEFAULT_PORTS` in TS only), so the
two layers can disagree on defaults.

## Evidence

- `core/src/files/mod.rs:16` ↔ `src/types/connection.ts:698` (`FileEntry`).
- `src/types/embeddedServer.ts:2-41` (+ TS-only `DEFAULT_PORTS` :44, `PROTOCOL_LABELS` :51).
- `src/services/api.ts:1197` (`TransferProgress`), `:1226` (`TransferSnapshot`), `:1181`
  (`TransferQueueState`).

## Recommendation

Adopt Rust→TS type generation (`ts-rs` or `typeshare`) for the IPC DTOs so the TypeScript types are
generated from the Rust source of truth instead of hand-mirrored, and move shared defaults
(`DEFAULT_PORTS`, monitoring interval, network-tool defaults) to the Rust side and generate/emit
them. This is the frontend↔backend analog of the app↔agent DTO problem (DUP-001) and the single
highest-leverage fix for cross-language drift.
