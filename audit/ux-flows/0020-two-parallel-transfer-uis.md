---
id: UX-020
title: Two parallel transfer UIs with different controls (browser footer vs Transfer Queue panel)
angle: ux-flows
severity: low
category: ux
is_workaround: false
subsystem: src/components/Sidebar/FileBrowser
evidence:
  - src/components/Sidebar/FileBrowser.tsx:1732
  - src/components/TransferQueue/TransferQueue.tsx:45
status: open
---

## What
The same transfers are surfaced in two different places with different controls:
- The file browser renders an in-sidebar transfer list from the transient `transfers` map
  (`FileBrowser.tsx:1732-1773`), scoped to the active browser session, with **only a Cancel**
  control (`:1344-1351`).
- The docked Transfer Queue panel (`TransferQueue.tsx`) shows Pause/Resume/Retry/Cancel/Remove.

Neither shows an ETA (UX-019), and the panel's extra controls are the misleading ones (UX-016).

## Why it matters
Two surfaces for one concept, with divergent control sets, is a consistency and legibility problem:
the user doesn't know which is authoritative or why the footer lacks Pause/Retry while the panel has
them (broken though they are). It fragments the transfer mental model.

## Evidence
- `FileBrowser.tsx:1732-1773` — sidebar footer transfer list, Cancel only.
- `TransferQueue.tsx:45-73` — panel with full control set.

## Recommendation
Consolidate on one transfer surface (or make the footer a scoped view of the same Transfer Queue
model with identical, working controls). At minimum, keep the control sets consistent once UX-016 is
resolved.
