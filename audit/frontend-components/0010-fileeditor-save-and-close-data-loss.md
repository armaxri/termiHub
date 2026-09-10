---
id: FEC-010
title: FileEditor "Save & Close" discards unsaved edits when the save did not actually succeed
angle: frontend-components
severity: high
category: bug
is_workaround: false
subsystem: src/components/FileEditor
evidence:
  - src/components/FileEditor/FileEditor.tsx:1055
  - src/components/FileEditor/FileEditor.tsx:1017
  - src/components/FileEditor/FileEditor.tsx:864
  - src/components/FileEditor/FileEditor.tsx:998
status: open
---

## What
`handleDialogSaveAndClose` awaits `handleSave()` and then closes the tab
unconditionally:
```ts
const handleDialogSaveAndClose = useCallback(async () => {
  const req = pendingCloseRequest;
  setPendingCloseRequest(null);
  await handleSave();
  if (req) closeTab(req.tabId, req.panelId);
}, [pendingCloseRequest, setPendingCloseRequest, handleSave, closeTab]);
```
But `handleSave` never signals failure — it swallows errors into `setSaveError`
(`:1017-1022`) and resolves normally. So `closeTab` runs even when the save did
not happen, destroying the buffer, in three real cases:

- **Failed save** (permission denied / read-only remote): the error banner is
  set, then the tab is closed anyway — edits lost.
- **Sudo path**: `handleSave` → `saveElevated` only *opens* the password dialog
  (`setSudoDialogOpen(true)`, `:864`) and returns immediately; `closeTab` fires
  while the prompt is still open, so the tab closes before the user can
  authorize.
- **Unsaved scratch, Save-As cancelled**: `handleSave` returns early on
  `if (!chosen) return` (`:998`); the tab is then closed, discarding the scratch
  content.

## Why it matters
Silent unsaved-data loss in the editor is a top-tier defect for a
safety-critical release: the user explicitly chose "Save & Close," the save
silently didn't happen, and their work is gone with only a banner on a
now-closed tab.

## Evidence
`src/components/FileEditor/FileEditor.tsx:1055-1060`, with the swallow at
`:1017-1022`, the sudo early-return at `:864`, and the Save-As cancel at `:998`.

## Recommendation
Make `handleSave` return a success boolean (and make `saveElevated` resolve only
after the elevated write actually completes, not when the dialog opens).
`handleDialogSaveAndClose` should `closeTab` only when the result is a confirmed
success; on failure it should keep the tab open with the error banner, and on
the sudo path it should defer the close until the elevated write resolves.
