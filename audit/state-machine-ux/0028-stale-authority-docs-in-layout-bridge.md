---
id: SM-028
title: Layout bridge JSDoc describes a feature-flag authority model and safety net that no longer exist
angle: state-machine-ux
severity: low
category: docs
is_workaround: true
subsystem: src/store/layoutBridge.ts + src/store/sessionBridge.ts
evidence:
  - src/store/layoutBridge.ts:16
  - src/store/layoutBridge.ts:404
  - src/store/sessionBridge.ts:581
status: open
---

## What
`layoutBridge.ts:16-46, 404-429, 556-567` and `{@link}` targets at `:14/:365/:426/:793` (and
`sessionBridge.ts:581`) describe an older gated-cut design — feature flags
`layoutIntentsEnabled` / `layoutRenderFromProjectionEnabled`, a `viewMatchesTree` faithful-
mirror gate, `seedLayoutRegion`, and an "appStore stays authoritative / instant-revert /
fallback to authoritative `appStore.rootPanel`" safety net. **None of those symbols exist in
`src/` anymore** post-#2562; they survive only as stale JSDoc and dangling `{@link}` targets.

## Why it matters
The code documents a safety net (fall back to the authoritative local tree on desync) that is
**gone** — a maintainer reasoning about the layout stuck-state (SM-024) or rollback divergence
(SM-027) would rely on a fallback that no longer exists and mis-diagnose the bug. Migration
residue that actively misleads; per the workaround mandate it should be cleaned up before
release.

## Evidence
- `layoutBridge.ts:16-46, 404-429, 556-567` — describes removed flags/gates/fallback.
- `layoutBridge.ts:14/365/426/793`, `sessionBridge.ts:581` — dangling `{@link}` targets.

## Recommendation
Rewrite the layout/session bridge JSDoc to the current region-mirror model (local reducer +
optimistic overlay + region subscriber as sole `layoutView` writer, no fallback), and delete
the dangling `{@link}` references.
