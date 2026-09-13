---
id: PROD-054
title: Command palette reaches only a curated subset of actions
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/services/commands
evidence:
  - src/services/commands.ts:79
  - src/services/commands.ts:36
status: open
---

## What
The palette iterates keybound actions and skips any without a wired runner; runners are a
hardcoded 14-entry table plus context commands. Many actions have no palette entry:
open/save/switch workspace, new SSH/serial/telnet connection, manage tunnels, open file
browser, network tools, plugin manager, disconnect/rename tab, etc.

## Why it matters
A command palette's core promise is reaching most of the app by keyboard. Here it reaches a
curated slice plus macros/workflows/connections, so users can't rely on it as a universal
launcher.

## Evidence
- `src/services/commands.ts:79-81` — skips actions without a runner.
- `:36-57` — hardcoded 14-entry `STORE_RUNNERS`.

## Recommendation
Register runners for the full keybinding action set (or generate palette entries from the
action registry) so every command is reachable.
