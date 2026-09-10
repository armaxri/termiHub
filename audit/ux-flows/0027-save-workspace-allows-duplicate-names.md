---
id: UX-027
title: Save Workspace allows duplicate names with no overwrite prompt
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/WorkspaceSidebar
evidence:
  - src/store/appStore.ts:7706
  - src/components/WorkspaceSidebar/SaveWorkspaceDialog.tsx:34
status: open
---

## What
`saveCurrentAsWorkspace` (`appStore.ts:7706-7713`) always mints a fresh id
(`ws-${Date.now()}-…`) and calls `apiSaveWorkspace` with no check against existing workspace names.
The Save dialog's only gate is a non-empty name (`SaveWorkspaceDialog.tsx:34-36,53`). Saving with a
name that already exists silently creates a **second workspace with the identical name**, not an
overwrite.

## Why it matters
Duplicate-named workspaces are indistinguishable in the sidebar list; the user cannot tell which is
which, and there is no "overwrite existing?" path — so updating a workspace by re-saving under the
same name is impossible without first deleting the old one. This is a data-management footgun.

## Evidence
- `appStore.ts:7706-7713` — always creates a new id, no name-collision check.
- `SaveWorkspaceDialog.tsx:34-36,53` — only guard is non-empty name.

## Recommendation
On save, detect an existing workspace with the same name and offer "Overwrite '<name>'?" vs "Save as
new". Alternatively enforce unique names with an inline error, like the connection editor does.
