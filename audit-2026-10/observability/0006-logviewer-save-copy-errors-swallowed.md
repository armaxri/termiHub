---
id: OBS2-006
title: "LogViewer Save and Copy failures are swallowed, so a failed log export looks like it worked"
angle: observability
severity: low
category: error-handling
is_workaround: false
subsystem: "src/components/LogViewer/LogViewer.tsx"
evidence:
  - src/components/LogViewer/LogViewer.tsx:102
  - src/components/LogViewer/LogViewer.tsx:113
  - src/components/LogViewer/LogViewer.tsx:114
  - src/components/LogViewer/LogViewer.tsx:123
  - src/components/LogViewer/LogViewer.tsx:133
  - src/components/LogViewer/LogViewer.tsx:50
status: open
resolution: ""
audit: 2026-10
commit: "663465d52"
relation: new
---

## What

handleSave wraps both the save dialog and `writeTextFile` in one try with an empty `catch { // Ignore errors (user cancelled dialog, etc.) }` (LogViewer.tsx:113-116). A cancelled dialog already returns null and is handled at :111, so the catch only ever swallows real write failures: permission denied, read-only volume, a scoped-fs rejection. handleCopyEntry and handleCopyAll (:123, :133) do the same with clipboard errors, and the initial getLogs failure is silently dropped (:50), leaving the viewer without backend history.

## Why it matters

This is the diagnostics surface a user relies on to report a bug. When it fails, it says nothing: the user thinks the logs were saved or copied and attaches an empty or missing file. The failure is not logged either, so it cannot be diagnosed later.

## Recommendation

Handle failures explicitly. Keep the null return (`if (!filePath) return`) as the cancel path. In the catch, call frontendError('log_viewer', `save logs failed: ${errorMessage(e)}`) and show a toast. Do the same for clipboard failures and for getLogs (one frontendWarn that backend history could not be loaded).

## Verification

Confirmed. handleSave returns early when the dialog yields null, so its empty catch only swallows real save failures (a dialog error or a writeTextFile failure), with a misleading 'user cancelled' comment. The clipboard handlers and the getLogs `.catch(() => {})` also swallow errors without logging or a toast.
