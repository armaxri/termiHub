---
id: PERF-002
title: FileEditor loads whole files with no size guard, and remote files cross IPC as JSON number arrays
angle: performance
severity: high
category: perf
is_workaround: false
subsystem: src/components/FileEditor, src/services/api.ts
evidence:
  - src/components/FileEditor/FileEditor.tsx:341
  - src/components/FileEditor/FileEditor.tsx:86
  - src/components/FileEditor/FileEditor.tsx:97
  - src/services/api.ts:1475
  - src/services/api.ts:1490
status: in-progress
resolution: "#2740 — size-guard done; number[] IPC re-encode deferred"
---

## What
Opening a file in the built-in editor reads the **entire file** into memory as a single
JS string with **no size guard** and hands it to Monaco. For **remote** (SFTP/session)
files the bytes additionally cross the Tauri IPC boundary as a **JSON array of numbers**
(`number[]`), one array element per byte, then get re-encoded byte-by-byte on write. There
is no "file too large to open" check anywhere on this path.

## Why it matters
- **Memory + IPC blowup on large files.** `session_read_file` returns `number[]`
  (`api.ts:1475`). A byte serialized into a JSON array averages ~3–4 characters of text
  (`"255,"`), so a 50 MB remote file becomes a ~150–200 MB JSON string over IPC, which is
  parsed into a 50M-element JS number array, then `TextDecoder`-decoded into a ~50 MB
  string, then handed to Monaco which builds its own model/tokenizer state on top. Peak
  memory is several × the file size, and the whole thing is synchronous work on the UI
  thread. A large log or dump opened by accident can freeze or OOM the app.
- **Write is symmetric.** `sessionWriteFileContent` does
  `Array.from(new TextEncoder().encode(content))` (`FileEditor.tsx:97`) — the full buffer
  is expanded into a JS number array and serialized as a JSON number array to the backend
  on every save.
- **No guard.** `loadContent` (`FileEditor.tsx:341`) unconditionally reads and sets the
  content; there is no max-size check, no streaming, no "open anyway?" affordance. Local
  files are slightly better (`localReadFile` returns a `string`, decoded backend-side) but
  are still fully in memory with no size guard.

## Evidence
- `src/services/api.ts:1475` — `export async function sessionReadFile(...): Promise<number[]> { return await invoke<number[]>("session_read_file", ...) }`.
- `src/services/api.ts:1490-1493` — `sessionWriteFile(sessionId, path, data: number[])`.
- `src/components/FileEditor/FileEditor.tsx:86-89` — `sessionReadFileContent` = `new TextDecoder().decode(new Uint8Array(await sessionReadFile(...)))`.
- `src/components/FileEditor/FileEditor.tsx:97` — `Array.from(new TextEncoder().encode(content))` on write.
- `src/components/FileEditor/FileEditor.tsx:341-360` — `loadContent()` reads the whole file with no size branch.

## Recommendation
- **Add a size guard before load.** `stat` the file first; above a threshold (e.g. 5–10 MB)
  refuse to open in the rich editor and offer a read-only/plain fallback or a "view first N
  lines" mode. This is the single most important fix — it bounds worst-case memory.
- **Stop shipping bytes as `number[]`.** Encode remote file bytes as base64 (as the
  terminal-output hot path already does, #2072) or use a binary `tauri::ipc::Channel`. This
  removes the ~4× IPC bloat and the per-byte JS array allocation on both read and write.
- Consider chunked/streamed transfer for large files so the read does not block the UI
  thread in one shot.
- Also applies to `read_plugin_file` (`api.ts:2470`), which returns `number[]`.
</content>
</invoke>
