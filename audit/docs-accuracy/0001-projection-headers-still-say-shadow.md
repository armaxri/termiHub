---
id: DOC-001
title: Backend projection module headers still say "Shadow / not yet driving the live UI" after the migration completed
angle: docs-accuracy
severity: high
category: docs
is_workaround: false
subsystem: src-tauri/src/*_projection
evidence:
  - src-tauri/src/lib.rs:1
  - src-tauri/src/system_monitor_projection/mod.rs:1
  - src-tauri/src/agents_projection/mod.rs:13
  - src-tauri/src/connections_projection/mod.rs:28
  - src-tauri/src/session_projection/mod.rs:12
  - src-tauri/src/settings_projection/mod.rs:38
  - src-tauri/src/transfers_projection/mod.rs:32
  - src-tauri/src/file_browser_projection/mod.rs:29
  - src-tauri/src/layout/mod.rs:11
  - src-tauri/src/workflow_projection/mod.rs:1
  - src-tauri/src/broadcast_projection/mod.rs:1
status: fixed
resolution: "#2723"
---

## What

The "stateless-UI reducer inversion" migration is reported complete — all domains cut over,
the backend regions are authoritative, the frontend reducers and client reconnect engine
deleted (per the project's own memory: "all 11 domains reducer/flag-free, backend/region
authoritative"). Yet the Rust module-header doc-comments (`//!`) on almost every
`*_projection` domain, and their declarations in `lib.rs`, still describe themselves as
non-authoritative **shadows** that are **"not yet driving the live UI"**. This is the
central architecture of the app, documented backwards.

## Why it matters

A contributor reading the backend to understand the state model is told the exact opposite
of what the code does: that appStore is authoritative and the projection "region nobody
renders" is inert. On a safety-critical codebase where docs-being-wrong is itself a defect,
mis-describing which layer is authoritative for every domain (sessions, connections,
settings, transfers, file browser, layout, system monitor, agents) is a high-impact
correctness gap. It is also demonstrably stale, not merely a judgment call — see the
internal contradictions below.

## Evidence

Uniformly-stale "shadow / not authoritative" headers:

- `src-tauri/src/system_monitor_projection/mod.rs:1` — `//! Shadow system-monitor authority`;
  L16-17 `//! The store is **not yet authoritative** …`.
- `src-tauri/src/agents_projection/mod.rs:1,13-17` — `//! Shadow agents authority` /
  `//! This step is deliberately **not** authoritative. … nothing in the live UI subscribes
  to or renders the agents region`.
- `src-tauri/src/connections_projection/mod.rs:1,28-31`, `session_projection/mod.rs:1,12-15`,
  `settings_projection/mod.rs:1,38-44`, `transfers_projection/mod.rs:1,32-36`,
  `file_browser_projection/mod.rs:1,29-33`, `layout/mod.rs:1,11-16` — same "Shadow … not
  authoritative … region nobody renders" framing (plus matching `store.rs` / `projection.rs`).
- `src-tauri/src/lib.rs` module-decl doc-comments repeat "Registered and served but **not yet
  driving the live UI**" for agents (L1-4), connections (L18-21), file_browser (L25-29),
  layout (L35-38), session (L71-74), settings (L76-81), system_monitor (L84-88), transfers
  (L91-95), workflow (L106-111).

**Internal contradictions that prove staleness** (one file updated, its sibling left behind):

- `broadcast_projection`: `projection.rs:55` `//! Now driving the live UI` and `lib.rs:9-10`
  `Now drives the live UI`, but `mod.rs:1,29-35` still `//! Shadow broadcast-membership
  authority` / `//! This step is deliberately **not authoritative**`.
- `workflow_projection`: `mod.rs:37-42` says the cut landed and `store.rs:23` agrees the store
  is authoritative, but `lib.rs:106-111` still says `not yet driving the live UI` and
  `mod.rs:1` still titles it `//! Shadow workflow-run authority`.
- `restore_cohort_projection`: `lib.rs:61-66` `The sole source of truth driving the live UI's
  aggregate summary toast`, but `mod.rs:29-34` / `projection.rs:39-44` still `//! # Shadow
  mode … not driving the live UI`.

## Recommendation

Do a single sweep updating every `*_projection` module header, `store.rs`/`projection.rs`
header, and the `lib.rs` module-decl doc-comments to describe the current authoritative role
(region drives the live UI; appStore mirrors/consumes it). Remove the "Shadow mode — zero
user-facing change" / "region nobody renders" blocks. Grep `src-tauri/src` for `Shadow`,
`not yet driving`, `not authoritative`, and `region nobody renders` and reconcile each hit.
Also update the narrative comments in `commands/connection.rs` and `connection/manager.rs`
that still speak of writing "into the shadow XStore".
