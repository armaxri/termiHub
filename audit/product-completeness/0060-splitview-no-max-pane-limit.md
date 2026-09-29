---
id: PROD-060
title: No maximum-pane / split-depth guard
angle: product-completeness
severity: low
category: ux
is_workaround: false
subsystem: src/utils/panelTree, src/components/SplitView
evidence:
  - src/utils/panelTree.ts:1
status: fixed
resolution: "#3122 — soft split guard: MIN_USABLE_PANE_PERCENT(5%)+leafSizePercent+canSplitLeaf in panelTree.ts; splitPanel + splitPanelWithTab edge-drop no-op + toast.error('Pane too small to split further') when target share would halve below min; center drops (tab re-stack) never blocked. Percentage floor (store has no px), below SplitView minSize=10 resize floor"
---

## What
Splitting is unbounded; there is no cap on pane count or split depth, so a user can subdivide
until panes are unusably small.

## Why it matters
A minor robustness/UX guard; may be intentional. Very small panes are unusable and easy to
create accidentally.

## Evidence
- No `maxPane/MAX_PANE/maxDepth` in `src/utils/panelTree.ts`, `SplitView.tsx`, or `appStore.ts`.

## Recommendation
Consider a soft cap or minimum pane size that blocks further splits with a hint.
