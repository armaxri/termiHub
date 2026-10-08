---
id: UI2-005
title: "The design-system source of truth and the ui-design agent still prescribe 'auto-hide' scrollbars and a non-installed list library"
angle: ui-visual
severity: low
category: docs-drift
is_workaround: false
subsystem: "docs/concepts/implemented/ui-modernization.html, .claude/agents/ui-design.md"
evidence:
  - docs/concepts/implemented/ui-modernization.html:512
  - docs/concepts/implemented/ui-modernization.html:1025
  - docs/concepts/implemented/ui-modernization.html:29
  - .claude/agents/ui-design.md:88
  - .claude/agents/ui-design.md:55
  - src/styles/global.css:50
  - package.json:42
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

ui-modernization.html, declared authoritative ('when the concept and the code disagree … fix the code'), still says scrollbars are 'unified into one auto-hide style' (l.512) and 'styled globally (auto-hide, global.css)' (l.1025). The #3144 maintainer decision made the thumb persistently visible on all platforms (global.css:50, pinned by tokenDiscipline 'persistent scrollbar' tests). Its proposed-token block still shows the pre-A11Y-007 focus ring (0 0 0 3px rgba(61,125,232,0.22), l.29). The ui-design agent repeats 'auto-hide' (l.88) and tells agents to use react-virtuoso for long lists (l.55), but only @tanstack/react-virtual is installed (package.json:42; the concept itself says react-virtual). The Sync Ledger was last synced 2026-07-25.

## Why it matters

Agents are told the concept wins over code. A ui-design agent following these docs would try to 'fix' the scrollbar back to auto-hide (the guard test would then fail and burn a CI round) or pull in a new virtualization dependency. That makes the docs a source of regressions against deliberate maintainer decisions.

## Evidence

- docs/concepts/implemented/ui-modernization.html:512
- docs/concepts/implemented/ui-modernization.html:1025
- docs/concepts/implemented/ui-modernization.html:29
- .claude/agents/ui-design.md:88
- .claude/agents/ui-design.md:55
- src/styles/global.css:50
- package.json:42

## Recommendation

Run /sync-concept ui-modernization. Change the scrollbar wording to 'persistent, visible thumb (#3144)', update the concept's token snippet to the current --shadow-focus double ring, and update the Sync Ledger date. In .claude/agents/ui-design.md, change rule 5 to 'persistent' and rule 2's list library to @tanstack/react-virtual.

## Verification

Confirmed. The concept says 'auto-hide' at l.512 and l.1025 and still has the old focus ring at l.29. global.css documents the persistent thumb (#3144). ui-design.md says auto-hide at l.88 and react-virtuoso at l.59 (not l.55 as cited). package.json has only @tanstack/react-virtual, and the concept's own table at l.1137 says react-virtual. This is docs drift that could mislead agents.
