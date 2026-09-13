---
id: PROD-008
title: No show/hide-hidden-files toggle in the file browser
angle: product-completeness
severity: low
category: ux
is_workaround: false
subsystem: core/files, src/components/Sidebar/FileBrowser
evidence:
  - core/src/files/local.rs:9
  - src/components/Sidebar/FileBrowser.tsx:1364
status: open
---

## What
Dotfiles/hidden files are always shown; there is no toggle to hide them.

## Why it matters
On Unix homes and config dirs the listing is dominated by dotfiles; users expect a
show/hide-hidden toggle (a near-universal file-manager control).

## Evidence
- `core/src/files/local.rs:9` and `src-tauri/src/files/local.rs:4` filter only `.`/`..`.
- No hidden-file toggle in the toolbar (`src/components/Sidebar/FileBrowser.tsx:1364-1494`)
  or filter (`src/utils/fileBrowserNav.ts`).

## Recommendation
Add a toolbar toggle (persisted) that filters entries beginning with `.` on Unix and honors
the hidden attribute on Windows.
