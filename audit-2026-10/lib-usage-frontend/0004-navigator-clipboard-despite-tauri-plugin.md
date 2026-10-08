---
id: LIBFE2-004
title: "Three copy actions use navigator.clipboard despite the installed Tauri clipboard plugin and the repo's own warning"
angle: lib-usage-frontend
severity: low
category: correctness
is_workaround: false
subsystem: "src/components/LogViewer, src/components/Settings"
status: open
resolution: ""
audit: 2026-10
commit: "663465d52"
relation: new
evidence:
  - src/components/LogViewer/LogViewer.tsx:122
  - src/components/LogViewer/LogViewer.tsx:132
  - src/components/Settings/GeneralSettings.tsx:109
  - src/components/Terminal/TerminalRegistry.tsx:410
---

## What

`@tauri-apps/plugin-clipboard-manager` is a dependency, `allow-write-text` is granted, and ten other components use it. TerminalRegistry.tsx:410-412 notes that `navigator.clipboard.writeText rejects on macOS/WKWebView when the document isn't focused, silently dropping the copy`. LogViewer's Copy entry and Copy all, and Settings' Copy debug info, still call `navigator.clipboard.writeText`. LogViewer swallows the rejection with an empty catch.

## Why it matters

A failed copy in LogViewer is silent: the user believes the redacted log is on the clipboard, and what gets pasted into a bug report is stale content. Mixing two clipboard backends is also exactly the inconsistency the installed plugin exists to remove.

## Recommendation

Replace these calls with `writeText` from `@tauri-apps/plugin-clipboard-manager`, as the other ten sites do. In LogViewer, show `toast.error` on failure instead of an empty catch. Optionally add an ESLint `no-restricted-properties` rule banning `navigator.clipboard` in src/.

## Verification

Confirmed. LogViewer.tsx:122/132 and GeneralSettings.tsx:109 call navigator.clipboard.writeText, while the clipboard-manager plugin is granted allow-write-text and other components use it. LogViewer swallows errors in an empty catch. In practice the copy comes from a click, so the document usually has focus and failures should be rare. Still low: it is an inconsistency with a silent-failure path.
