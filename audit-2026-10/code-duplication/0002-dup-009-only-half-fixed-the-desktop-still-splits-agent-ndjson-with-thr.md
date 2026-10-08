---
id: DUP2-002
title: "DUP-009 only half fixed: the desktop still splits agent NDJSON with three hand-rolled, uncapped String accumulators that decode lossy UTF-8 per chunk"
angle: code-duplication
severity: medium
category: duplication
is_workaround: false
subsystem: "src-tauri terminal/agent_manager (desktop side of the agent wire)"
evidence:
  - src-tauri/src/terminal/agent_manager/io_task.rs:422-429
  - src-tauri/src/terminal/agent_manager.rs:3029-3052
  - src-tauri/src/terminal/agent_manager/reattach.rs:228-236
  - core/src/ipc/ndjson.rs:169
  - audit/code-duplication/0009-ndjson-framing-reimplemented-three-ways.md:20-53
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: previous-incomplete
previous_id: DUP-009
---

## What

DUP-009 named three framing implementations and recommended one core primitive 'over AsyncRead and, where the ssh channel isn't an AsyncRead, a small push(bytes) -> lines state machine'. The fix (#2929) moved only the agent read path onto `core::ipc::ndjson::read_line_resumable`. The desktop leg (#3 in the original finding) was never migrated, and the desktop now has three separate copies of the same accumulate-and-split code: the main I/O loop (`line_buf.push_str(&String::from_utf8_lossy(data))` then `find('\n')` and copying the tail, io_task.rs:423-429), `read_handshake_line` (agent_manager.rs:3035-3052) and reattach `drain_complete_lines` (reattach.rs:231-236). None enforces the core line cap, and two decode `from_utf8_lossy` per SSH chunk.

## Why it matters

Because the framing is copied rather than shared, bugs repeat in every copy and a fix for one misses the others. The per-chunk lossy decode corrupts multi-byte UTF-8 split across chunk boundaries in both the handshake and the main loop. The missing cap is the unbounded-memory vector that AGT-013 was believed to have closed. The agent-protocol angle reports these defects separately (AGT2-001 for UTF-8, AGT2-003 for the cap). This finding is the root cause: the shared core primitive the dedup fix promised does not exist for the desktop's push-based reader.

## Recommendation

Add a push-based `core::ipc::ndjson::LineSplitter` with `push(&[u8]) -> impl Iterator<Item = Result<String, LineTooLong>>` that works on bytes, keeps a scan offset and an incomplete-UTF-8 tail, and enforces `MAX_LINE_LEN`, sharing its cap and oversize semantics with `read_line_resumable`. Replace all three desktop accumulators with it. Treat an over-cap line as a protocol error that tears down the agent connection. Move the existing agent oversize and fragment tests onto the shared type.

## Verification

Confirmed. io_task.rs:423-429 push_str(from_utf8_lossy(data)) + find('\n'), agent_manager.rs:3035-3052 read_handshake_line the same, reattach.rs drain_complete_lines a third split. There's no MAX_LINE_LEN or cap anywhere in src-tauri agent_manager. The DUP-009 resolution note says only the agent read path moved to read_line_resumable. The desktop leg was never migrated, and no documented decision covers it.
