---
id: WA-FE-006
title: Production console.error used instead of the mandated LogViewer/frontendLog
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: components (FileEditor, ActivityBar, ErrorBoundary)
evidence:
  - src/components/FileEditor/FileEditor.tsx:1020
  - src/components/ActivityBar/ActivityBar.tsx:116
  - src/components/ui/ErrorBoundary.tsx:44
status: open
---

## What
Three production sites log via `console.error`, which the project's coding standard explicitly
forbids for debug/diagnostic output ("Always use the internal LogViewer … never use
`console.log`/`console.warn`/`console.error`"; use `frontendLog`):

```ts
console.error("Save failed:", err);                 // FileEditor.tsx:1020
console.error("Failed to read import file:", err);  // ActivityBar.tsx:116
console.error(`React render error${scope}:`, ...);  // ErrorBoundary.tsx:44
```

## Why it matters
- The browser DevTools console is not accessible to the user; the in-app LogViewer is. These
  failures (a failed file save, a failed settings import, a React render crash) are exactly the
  ones a user would need to report — and they land where the user cannot see them.
- FileEditor's "Save failed" is a mutating user action failing with only a console line — it also
  trips the "every action gives feedback" rule.

## Evidence
- `src/components/FileEditor/FileEditor.tsx:1020`
- `src/components/ActivityBar/ActivityBar.tsx:116`
- `src/components/ui/ErrorBoundary.tsx:44`

## Recommendation
Route through `frontendLog(...)` (and, for the FileEditor save failure, also a `toast.error`).
ErrorBoundary is the one defensible `console.error` (it runs when the app tree is broken and the
LogViewer may be unavailable) — but it should additionally attempt a `frontendLog` so a recoverable
render error is captured. Zero `console.*` outside ErrorBoundary is the signal.
