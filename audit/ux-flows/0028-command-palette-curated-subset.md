---
id: UX-028
title: Command palette is a curated subset — sibling commands and major surfaces are unreachable
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/services/commands
evidence:
  - src/services/commands.ts:77
  - src/services/keybindings.ts:283
status: open
---

## What
`buildCommands()` (`commands.ts:77-91`) only surfaces keybinding actions that have a runner in
`STORE_RUNNERS` or `CONTEXT_COMMANDS`; any action without a runner is skipped (`:80-81`). This
produces visible inconsistencies and gaps:
- **Missing siblings:** `close-tab-group`, `next-tab-group`, `prev-tab-group`
  (`keybindings.ts:283-307`) and clipboard `copy`/`paste`/`select-all` (`:161-187`) have no runner
  and never appear — yet `new-tab-group` **is** in the palette (`commands.ts:52`). A user who finds
  "New Tab Group" reasonably expects Close/Next/Previous and can't find them.
- **Missing major surfaces:** the palette covers commands + connections + macros + workflows
  (`CommandPalette.tsx:87-115`) but has **no** entries for opening Settings sub-pages, Workspaces,
  Network Tools, the Open Connections panel, Tunnels, Embedded Servers, or the file browser.

## Why it matters
The command palette is the primary discoverability tool, but it is not a reliable "do anything"
entry point — large parts of the app are unreachable through it, and the partial coverage of a group
(New Tab Group present, its siblings absent) actively misleads. This undercuts keyboard-first
discoverability. Corroborates product-completeness PROD-054, framed here as a discoverability/
consistency defect.

## Evidence
- `commands.ts:77-91` — actions without a runner are dropped.
- `keybindings.ts:283-307,161-187` — defined actions with no runner (never in palette).
- Good: inert context commands are shown disabled with a tooltip rather than hidden
  (`CommandPalette.tsx:235-246`).

## Recommendation
Add runners (or palette entries) for the missing sibling commands and for the major navigational
surfaces (open Settings pages, Workspaces, tools, Open Connections). Aim for the palette to reach
every user-invocable action, not a hand-picked subset.
