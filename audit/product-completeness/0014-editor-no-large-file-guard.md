---
id: PROD-014
title: File editor has no large-file guard — whole file loaded into Monaco
angle: product-completeness
severity: high
category: reliability
is_workaround: false
subsystem: src/components/FileEditor, core/files
evidence:
  - src/components/FileEditor/FileEditor.tsx:2
  - src-tauri/src/commands/files.rs:83
  - core/src/backends/ssh/file_browser.rs:237
status: in-progress
resolution: "#2740"
---

## What
Opening a file reads the entire content into memory and hands it to Monaco. There is no
size check, truncation, streaming, or read-only-for-large-files guard.

## Why it matters
Opening a large log or data file (hundreds of MB) will read it fully into memory and can
freeze or crash the app — a common accidental action (double-click a big file). This is a
reliability hazard on a routine path.

## Evidence
- `src/components/FileEditor/FileEditor.tsx` — no `MAX_FILE_SIZE`/size check (size used only for external-change polling `:702-732`).
- `src-tauri/src/commands/files.rs:83-86` — local read returns full String.
- `core/src/backends/ssh/file_browser.rs:237-256` — remote read returns whole `Vec<u8>`.

## Recommendation
Add a size threshold: warn and open read-only/truncated (or offer download instead) above a
configurable limit; consider streamed/virtualized read for large files.
