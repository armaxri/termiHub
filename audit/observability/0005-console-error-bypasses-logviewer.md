---
id: OBS-005
title: Production console.error bypasses LogViewer and durable file log
angle: observability
severity: medium
category: bug
is_workaround: true
subsystem: src/components/ui/ErrorBoundary.tsx, src/components/FileEditor, src/components/ActivityBar
evidence:
  - src/components/ui/ErrorBoundary.tsx:44
  - src/components/FileEditor/FileEditor.tsx:1020
  - src/components/ActivityBar/ActivityBar.tsx:116
status: fixed
resolution: "#2727"
---

## What
Three production code paths still emit `console.error`, which the repo's own logging policy
("never use console.* for debug output; use the LogViewer") forbids — and which means the
output goes only to the WebView DevTools console, invisible to both the LogViewer and the
durable file log:

- `ErrorBoundary.tsx:44` — `console.error("React render error…", error, info.componentStack)`.
  This is the **React crash path**: when a component subtree throws, the boundary's only
  record is a DevTools console line. A render crash therefore leaves no trace in the
  LogViewer and (compounded by OBS-001) none in `termihub.log`. The most severe frontend
  failure is the least observable.
- `FileEditor.tsx:1020` — `console.error("Save failed:", err)` on a file-save failure.
- `ActivityBar.tsx:116` — `console.error("Failed to read import file:", err)` on a
  config/import read failure.

## Why it matters
The DevTools console is not reachable by users or field supporters (`.claude/CLAUDE.md`
states this explicitly). These three are real user-facing failures — a UI crash, a failed
save, a failed import — and each is diagnosable only by someone who happens to have DevTools
open at the moment it happens. They also directly contradict the acceptance criterion the
`storeErrorSurfacing`/`vscode-feedback` test suites were written to enforce, so they are
residual instances of the very bug that cleanup targeted.

## Evidence
Grep for `console.error` across `src/**` (excluding tests) returns exactly these three
non-test hits. All other former `console.error` call sites were migrated to `frontendLog`
+ toast per the `appStore.storeErrorSurfacing.test.ts` campaign; these three were missed.

## Recommendation
Route all three through `frontendLog` (and, for ErrorBoundary and the two user actions, a
recoverable `toast`). The ErrorBoundary is the highest priority — a render crash must be
logged with the component stack via `frontendLog("react", …)` so it is captured once
OBS-001 makes frontend logs durable. Add an ESLint `no-console` rule (allow only an
explicit escape hatch) so the policy is enforced mechanically rather than by review.
