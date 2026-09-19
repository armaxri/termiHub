---
id: LIBFE-004
title: Sidebar tree search uses hand-rolled substring match while match-sorter is already installed
angle: lib-usage-frontend
severity: info
category: ux
is_workaround: false
subsystem: src/utils/connectionSearch, src/utils/agentTreeSearch
evidence:
  - src/utils/connectionSearch.ts:30
  - src/utils/agentTreeSearch.ts:32
  - src/components/CommandPalette/CommandPalette.tsx:126
status: open
---

## What

The sidebar tree filters (`connectionMatchesQuery`, `agentDefinitionMatchesQuery`)
use plain `.toLowerCase().includes(query)` substring matching with no ranking. The
Command Palette, meanwhile, already uses the installed `match-sorter` library for
fuzzy, ranked matching (`CommandPalette.tsx:126`). So the app ships two different
search behaviours for conceptually the same thing (find a connection/agent by
typing), and only one of them is the good one.

## Why it matters

This is a UX consistency observation, not a bug. `match-sorter` is **already a
dependency** (`match-sorter` in `package.json`), so there is no supply-chain or
bundle-size cost to using it more widely. Users who learn that the command palette
does forgiving fuzzy/ranked matching will expect the connection sidebar search to do
the same; instead it does strict substring matching and returns matches in tree
order with no relevance ranking.

## Evidence

- `src/utils/connectionSearch.ts:30` — `connectionMatchesQuery` = `.includes()`.
- `src/utils/agentTreeSearch.ts:32,41` — `agentNameMatchesQuery` /
  `agentDefinitionMatchesQuery` = `.includes()`.
- `src/components/CommandPalette/CommandPalette.tsx:126` — `matchSorter(entries, query, …)`.

## Recommendation

Low-priority, and the tree-walking half must stay: the ancestor-folder reveal /
auto-expand logic in `filterConnectionTree` / `filterAgentTree` is genuinely
domain-specific and should NOT be replaced. But the **leaf match test** (does this
connection/agent match the query?) can delegate to `match-sorter`'s ranking to give
the sidebar the same forgiving, ranked search the palette already has, reusing a lib
that is already installed and already trusted in the codebase. If the maintainer
prefers strict substring matching in the tree for predictability, this is a
legitimate keep-as-is — hence `info`, not a defect.
