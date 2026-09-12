---
id: UX-018
title: File editor has no large-file guard — opening a big remote file can freeze the app
angle: ux-flows
severity: high
category: reliability
is_workaround: false
subsystem: src/components/FileEditor
evidence:
  - src/components/FileEditor/FileEditor.tsx:341
  - src/components/FileEditor/FileEditor.tsx:86
status: fixed
resolution: "#2740 — already-on-develop: FileEditor large-file guard (#PROD-014/#PERF-002) with Open-anyway — audit branch stale"
---

## What
There is no size guard anywhere in the file-editor load path. `FileEditor.tsx:341-360` reads the
entire file into memory (`sessionReadFileContent` decodes the whole byte array at `:86-89`; local
via `localReadFile` at `:347`) and hands the whole string to Monaco. No max-size check, no
streaming, no warning, no cancel. Worse, the editor's external-change watch triggers a **full
re-read** of the whole file on every detected change (`reloadFromDisk` → `readEffectiveContent`,
`:530-535`), compounding the cost for large remote files.

## Why it matters
Opening a multi-hundred-megabyte remote log via the file browser's "Edit" action reads the entire
file over SFTP into a JS string and into Monaco — a likely UI freeze or crash, with no warning and
no way to back out. This is a reliability gap on a plausible common action (editing/viewing server
logs). Corroborates product-completeness PROD-014, framed here as the UX/recovery failure: the user
gets no guard, no progress, and no escape.

## Evidence
- `FileEditor.tsx:341-360` — whole-file read into memory, no size check.
- `FileEditor.tsx:86-89` — session read decodes the entire byte array.
- `FileEditor.tsx:530-535` — external change triggers a full re-read.

## Recommendation
Add a size guard on open: above a threshold, warn the user and offer view-only/tail/"open anyway"
rather than silently loading everything; ideally stream or page large files. At minimum, `stat`
before read and prompt for confirmation past a configurable size.
