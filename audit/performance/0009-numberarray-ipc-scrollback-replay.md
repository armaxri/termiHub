---
id: PERF-009
title: Scrollback-replay and agent-buffer IPC ship up to 1 MiB as JSON number arrays
angle: performance
severity: medium
category: perf
is_workaround: false
subsystem: src/services/api.ts, src-tauri (buffer replay commands)
evidence:
  - src/services/api.ts:469
  - src/services/api.ts:830
  - core/src/buffer/mod.rs:7
status: open
---

## What
The reconnect / move-window / persistent-reattach scrollback-replay paths transfer the
session's ring buffer across IPC as a JSON array of numbers (`number[]`), one element per
byte. The ring buffer is 1 MiB by default (`DEFAULT_BUFFER_CAPACITY = 1_048_576`), so a full
buffer becomes a JSON array of ~1,000,000 numbers.

## Why it matters
A byte rendered as a JSON array element averages ~3–4 characters (`"200,"`), so a full 1 MiB
buffer serializes to a ~3–4 MB JSON string on the backend, is parsed into a 1M-element JS
number array on the frontend, then copied into a `Uint8Array` and written to xterm. This is
~4× the wire size of the raw bytes plus a large transient allocation, all synchronous, and
it happens exactly at the latency-sensitive moment the user is watching a terminal
reconnect / reattach / move to a new window. The live terminal-output hot path already
solved this by switching to base64 (#2072); these replay paths did not get the same
treatment.

## Evidence
- `src/services/api.ts:469` — `const bytes = await invoke<number[]>("replay_session_scrollback", { sessionId });`
- `src/services/api.ts:830` — `const bytes = await invoke<number[]>("get_agent_session_buffer", { sessionId });`
- `core/src/buffer/mod.rs:7` — `pub const DEFAULT_BUFFER_CAPACITY: usize = 1_048_576;` (the amount that can be replayed).
- Consumed by `Terminal.tsx` reattach/replay paths (`getAgentSessionBuffer`, `replaySessionScrollback`).

## Recommendation
- Encode these buffers as base64 (reuse the exact `serialize_bytes_base64` / `base64ToBytes`
  pair the terminal-output path already uses) or a binary `tauri::ipc::Channel`, removing
  the ~4× bloat and the 1M-element array allocation.
- Same treatment applies to `session_read_file` / `session_write_file` (see PERF-002) and
  `read_plugin_file` — all currently `number[]`.
</content>
</invoke>
