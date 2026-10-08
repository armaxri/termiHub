---
id: UISF2-005
title: "UnsavedChangesDialog hardcodes 'This connection has unsaved changes' but is reused for file-editor tabs"
angle: ui-shared-foundation
severity: low
category: ui
is_workaround: false
subsystem: "src/components/ConnectionEditor"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - src/components/ConnectionEditor/UnsavedChangesDialog.tsx:22
  - src/components/ConnectionEditor/UnsavedChangesDialog.tsx:41
  - src/components/FileEditor/FileEditor.tsx:55
  - src/components/FileEditor/FileEditor.tsx:1613
  - src/components/Terminal/TabBar.tsx:316
---

## What

`UnsavedChangesDialog` lives in ConnectionEditor and hardcodes its copy twice: as `description` (sr-only) and again as body text, 'This connection has unsaved changes. What would you like to do?'. FileEditor imports it across feature boundaries for closing a dirty file tab. TabBar's fallback ConfirmDialog for the same file-close flow says 'This file has unsaved changes'.

## Why it matters

Closing a modified file in the editor shows a dialog that talks about a 'connection', which is wrong and confusing on a data-loss prompt. Because the same sentence is both the description and the body, screen readers also announce it twice. The component was shared without being parameterised.

## Evidence

- `src/components/ConnectionEditor/UnsavedChangesDialog.tsx:22`
- `src/components/ConnectionEditor/UnsavedChangesDialog.tsx:41`
- `src/components/FileEditor/FileEditor.tsx:55`
- `src/components/FileEditor/FileEditor.tsx:1613`
- `src/components/Terminal/TabBar.tsx:316`

## Recommendation

Give UnsavedChangesDialog a `subject` prop ("connection" | "file"), or a `message` prop, and pass "file" from FileEditor. Remove the duplicated body/description: keep the description and use the body for the subject name. Move the component into a shared location (e.g. components/ui or components/dialogs), since two features consume it.

## Verification

Confirmed. UnsavedChangesDialog hardcodes 'This connection has unsaved changes…' as both the description and the body. FileEditor.tsx:55/1613 imports it for closing a dirty file tab. TabBar's ConfirmDialog for the same flow says 'This file has unsaved changes'.
