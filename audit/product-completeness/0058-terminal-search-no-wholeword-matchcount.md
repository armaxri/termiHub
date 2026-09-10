---
id: PROD-058
title: Terminal search lacks whole-word toggle and match-count readout
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: src/components/Terminal
evidence:
  - src/components/Terminal/TerminalSearchBar.tsx:17
  - src/components/Terminal/TerminalRegistry.tsx:449
status: open
---

## What
Search offers case-sensitive and regex toggles but no whole-word match and no "3 of 17"
match-count indicator (the search addon's `onDidChangeResults` is not wired).

## Why it matters
Match count and whole-word are standard find-UI affordances; without count the user can't tell
how many hits exist.

## Evidence
- `src/components/Terminal/TerminalSearchBar.tsx:17-18` — only `caseSensitive`/`useRegex`.
- `src/components/Terminal/TerminalRegistry.tsx:449-462` — findNext/Prev return bare boolean; `onDidChangeResults` unused.

## Recommendation
Wire `SearchAddon.onDidChangeResults` for a match-count readout and add a whole-word option.
