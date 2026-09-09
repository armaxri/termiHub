---
id: PROD-059
title: No shell-command-history / prompt-mark navigation in the terminal
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: src/components/Terminal
evidence:
  - src/components/Terminal/Terminal.tsx:1
status: open
---

## What
CWD is tracked (OSC 7/9) but command boundaries are not (no OSC 133 handling). There is no
jump-to-previous/next-prompt or in-terminal command-history navigation. (RecentSessions covers
connection history, not in-terminal commands.)

## Why it matters
Prompt navigation and command decorations (VS Code terminal, iTerm2) are increasingly expected
for scrolling through long output by command.

## Evidence
- No `registerMarker/registerDecoration/osc133/command-mark` in `src/components/Terminal/Terminal.tsx`.
- "Shell integration" in-repo injects setup snippets, not prompt marks.

## Recommendation
Add OSC 133 command-mark handling with prompt-jump navigation and per-command decorations.
