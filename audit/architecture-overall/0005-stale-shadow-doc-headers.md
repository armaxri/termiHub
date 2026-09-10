---
id: ARCH-005
title: Backend projection module headers still describe live domains as inert "shadows", misrepresenting which layer owns state
angle: architecture-overall
severity: medium
category: docs
is_workaround: false
subsystem: src-tauri/src/*_projection
evidence:
  - src-tauri/src/connections_projection/mod.rs:1
  - src-tauri/src/settings_projection/mod.rs:1
  - src/store/appStore.ts:895
status: open
---

## What

The backend `*_projection` module doc headers still describe their domains as
**"Shadow … registered and served but not yet driving the live UI"**, but the
frontend has already cut those domains over: `appStore` no longer holds their
state and reads exclusively from the projection region.

Concretely, for the same domain the two ends of the codebase disagree:

| Domain | Backend header (src-tauri) | Frontend reality (appStore) |
| --- | --- | --- |
| connections | "**Shadow** connections-tree authority … Phase 5" (`connections_projection/mod.rs:1`) | "region-authoritative (#2401) … **`appStore` holds no connections/folders slice**" (`appStore.ts:895-899`) |
| settings | "**Shadow** app-settings authority … Phase 5" (`settings_projection/mod.rs:1`) | "region-authoritative (#2404) … **`appStore` holds no settings/savedSettings slice**" (`appStore.ts:901-905`) |
| transfers | "pure shadow foundation" (`lib.rs:917-926`) | "no longer held in `appStore` … the shared `transfers` region is authoritative (#2229/#2387)" (`appStore.ts:1024-1030`) |

The `lib.rs` registration comments carry the same stale "not yet driving the
live UI" / "reducers retained as the parity-safe fallback" language for agents,
system-monitor, settings, connections, transfers, workflow, file-browser
(`lib.rs:774-930`), while the coordinator's own record states all 11 domains are
reducer/flag-free and region-authoritative as of 2026-08-26.

## Why it matters

- **A reader cannot trust the authoritative-looking module headers to tell them
  which layer owns a piece of state** — the single most important fact about
  this architecture. An investigation that reads `session_projection/mod.rs`
  ("nothing in the live UI subscribes") reaches the opposite conclusion from one
  that reads `appStore.ts` ("region-authoritative"). This exact split produced
  contradictory reads during this audit.
- On a safety-critical codebase, stale "this is inert" comments on code that is
  in fact on the live path are a latent-hazard multiplier: someone edits a
  "shadow" store believing nothing consumes it.

## Evidence

- `src-tauri/src/connections_projection/mod.rs:1-6`, `settings_projection/mod.rs:1-6`,
  `session_projection/mod.rs:1-9` — "Shadow … not yet driving the live UI".
- `src/store/appStore.ts:895-905,1024-1030` — the same domains declared
  region-authoritative with no appStore slice (#2401/#2404/#2229).
- `src-tauri/src/lib.rs:774-930` — registration comments repeat the stale
  "shadow / parity-safe fallback" framing.

## Recommendation

Sweep every `*_projection` module header and the `lib.rs` registration comments
and update them to the current authority state (render cut / mutation cut /
reducer removed), or delete the phase narrative and state plainly "authoritative
for X; the frontend renders from this region." Add a one-line authority table to
`docs/architecture.md §State Management` so there is a single canonical answer
for "who owns this domain's state." This is cheap and removes a whole class of
mis-reads before release.
