---
id: PROD-005
title: Multi-select supports copy/cut/delete but not multi-download
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/components/Sidebar/FileBrowser
evidence:
  - src/components/Sidebar/FileBrowser.tsx:280
  - src/components/Sidebar/FileBrowser.tsx:1229
status: open
---

## What
The multi-select action menu offers only Copy/Cut/Delete. Download is a single-entry action
only, so a user cannot select N files and download them together.

## Why it matters
Bulk download is a standard file-manager expectation; users must download files one at a time.

## Evidence
- `src/components/Sidebar/FileBrowser.tsx:280-329` — multi-select menu (Copy/Cut/Delete).
- `handleMultiAction` `:1229-1269` handles only copy/cut/delete.
- Download item is single-entry only (`:194-202`, `:1027-1029`).

## Recommendation
Extend `handleMultiAction` with a `download` branch that enqueues each selected entry
(recursing directories) into the transfer queue.
