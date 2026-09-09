---
id: PROD-007
title: File browser is single-pane with no bookmarks/favorites
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/components/Sidebar/FileBrowser
evidence:
  - src/components/Sidebar/FileBrowser.tsx:1
status: open
---

## What
The file browser is a single-pane sidebar with one `currentPath`. There is no dual-pane
(local↔remote or remote↔remote) view and no bookmarked/favorite directories.

## Why it matters
Dual-pane side-by-side transfer is the defining UX of WinSCP/FileZilla/Total Commander and
the primary way users move files between machines. Bookmarks avoid re-navigating deep paths.

## Evidence
- `src/components/Sidebar/FileBrowser.tsx` — single-pane component, one path/entries set.
- No `dualPane`/`dual-pane`/`bookmark` anywhere in `src/components/Sidebar/*` or `src/store/*`
  (an internal cross-pane clipboard concept exists but there is no second visible pane).

## Recommendation
Offer a two-pane file transfer view (at least local↔remote) and a persisted bookmarks list
per connection. This is the single biggest UX gap for power file-transfer users.
