---
id: ARCH2-005
title: "ADR-14 and session-command comments misstate current state authority (layout 'deferred outlier', client-owned reconnect, regions 'in lib.rs')"
angle: architecture-overall
severity: low
category: docs
is_workaround: false
subsystem: "docs/architecture.md, src-tauri/src/commands/session.rs"
evidence:
  - docs/architecture.md:3104
  - docs/architecture.md:3114
  - docs/architecture.md:3143
  - src-tauri/src/commands/session.rs:110
  - src-tauri/src/commands/session.rs:122
  - src-tauri/src/session_projection/redrive.rs:22
  - src-tauri/src/boot/mod.rs:755
  - src-tauri/src/plugin_sandbox_projection/mod.rs:1
status: fixed
resolution: "#4369 — ADR-14 status updated (layout inverted, boot::seed_projection_regions, plugin-sandbox); create_connection comments name the backend redrive"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Several statements in ADR-14's status block no longer match the code. It says layout is 'one deferred outlier' whose 'layout reducers remain as the render source' pending #2562 (lines 3114, 3143), but #2562 is closed and ARCH-004 recorded the layout region as the only writer. It says the regions are 'registered in src-tauri/src/lib.rs' (3104); they are now in boot/mod.rs. Its region list leaves out the `plugin-sandbox` region added in #4188. In commands/session.rs:110-123 the `create_connection` comments still say a reconnect attempt's lifecycle 'is owned by the client' and that the give-up 'live[s] in the client engine, part of #2205'. #2205 is closed, and redrive.rs:22 states the client reconnect engine was deleted and the backend redrive is the only driver.

## Why it matters

The previous audit's release-blocking theme (ARCH-003/004/005) was that nobody, contributor or auditor, could reliably answer 'which copy of this state is real?'. The module headers were fixed, but the authoritative ADR and the main session-creation entry point now describe the opposite authority again. On the safety-critical path that is the kind of misdirection that leads to wrong fixes, such as adding client-side reconnect handling that is assumed to exist.

## Recommendation

Update ADR-14's status block: layout is fully inverted (#2562 closed), registration lives in `boot::seed_projection_regions`, and `plugin-sandbox` (read-only, #4188) is in the list. Delete the 'one deferred reducer removal' trade-off. Rewrite the commands/session.rs:107-123 comment to name the backend redrive as the reconnect owner. Optionally, add a doc-lint test that checks the region list in ADR-14 against the `register_region` call sites.

## Verification

Confirmed. ADR-14's status block (architecture.md ~3104) still says the regions are registered in src-tauri/src/lib.rs; seed_projection_regions is now in boot/mod.rs:737. It still calls layout 'one deferred outlier' pending #2562, which gh reports CLOSED. Its region list leaves out plugin-sandbox (documented only in the table at line 2329). The commands/session.rs:110-123 comments still say reconnect is client-owned and the give-up lives 'in the client engine, part of #2205', which contradicts the deleted client engine. This is documentation drift only; low.
