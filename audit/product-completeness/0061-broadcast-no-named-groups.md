---
id: PROD-061
title: No persistent named broadcast group (custom set must be reselected each session)
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: src/types/terminal
evidence:
  - src/types/terminal.ts:337
status: open
---

## What
Broadcast scopes are `all | panel | custom`. There is no saved/named terminal group to
broadcast to; a custom set must be reselected each session.

## Why it matters
tmux/iTerm let you define a reusable broadcast group; re-picking a custom set each time is
friction for repeated multi-host workflows.

## Evidence
- `src/types/terminal.ts:337` — `BroadcastScope = "all" | "panel" | "custom"`.

## Recommendation
Allow saving a named broadcast group (possibly tied to tab groups) as a reusable scope.
