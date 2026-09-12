---
id: DEAD-011
title: Backend projection modules still document themselves as "Shadow / not authoritative"
angle: deadcode-flags
severity: low
category: docs
is_workaround: false
subsystem: src-tauri/src/*_projection, src-tauri/src/lib.rs
evidence:
  - src-tauri/src/agents_projection/mod.rs:13
  - src-tauri/src/file_browser_projection/mod.rs:29
  - src-tauri/src/restore_cohort_projection/mod.rs:31
  - src-tauri/src/system_monitor_projection/store.rs:24
  - src-tauri/src/lib.rs:1
status: fixed
resolution: "#2723"
---

## What
After the stateless-UI inversion completed (10/11 domains region-sole-authority,
local reducers deleted), the backend projection module headers and the `lib.rs`
region-registration comments still describe every region as **"Shadow … zero
user-facing change … deliberately not authoritative"**. For the migrated domains that
is now false — those regions *are* the authority.

## Why it matters
Pervasive stale doc headers actively mislead: a reader auditing "what still needs
finishing" will conclude these regions are inert shadows pending a cut that already
happened. It also masks the one place the wording is still *true* — layout (DEAD-004)
— by making the accurate and inaccurate uses indistinguishable.

## Evidence
- `grep -rn "not authoritative\|Shadow" src-tauri/src` returns "Shadow … not
  authoritative" headers across `agents_projection`, `connections`(lib.rs),
  `file_browser_projection`, `restore_cohort_projection`, `system_monitor_projection`,
  `broadcast_projection`, `settings`, `transfers`, `workflow_run`, and the `lib.rs`
  region-doc block (`lib.rs:1-106`, `:777-917`).
- Contrast the frontend, which was updated: `sessionBridge.ts:24` "Backend-authoritative
  (migration flags removed, #2283)".

## Recommendation
Rewrite the module/region headers for the migrated domains to state they are the
authoritative source; keep the "shadow / not authoritative" language **only** for
layout until DEAD-004/#2562 lands. Note: this overlaps the docs-accuracy angle's
DOC-001 — coordinate so it is fixed once, not twice.
