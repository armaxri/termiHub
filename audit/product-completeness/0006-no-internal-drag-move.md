---
id: PROD-006
title: File browser drag-and-drop is OS→app upload only; no drag-to-move within the browser
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/components/Sidebar/FileBrowser
evidence:
  - src/components/Sidebar/FileBrowser.tsx:851
status: open
---

## What
Drag-and-drop only handles dropping OS files into the browser to upload. There is no
drag of a row onto a folder to move/copy it, and no drag between two remote views.

## Why it matters
Drag-to-move is a core direct-manipulation affordance in every file manager; its absence
forces cut→navigate→paste for every move.

## Evidence
- `src/components/Sidebar/FileBrowser.tsx:851-860` — `handleOsDrop` uploads dropped OS paths only, via `uploadFileFromPath`.

## Recommendation
Add intra-browser HTML5 drag sources on rows with folder drop targets that issue a
rename/move (or copy on modifier), reusing the existing move/copy plumbing.
