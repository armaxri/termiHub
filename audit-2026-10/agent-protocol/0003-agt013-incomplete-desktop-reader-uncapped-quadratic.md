---
id: AGT2-003
title: "AGT-013 fix missed the real desktop reader: agent stdout is accumulated into an uncapped String, with quadratic rescans and copies"
angle: agent-protocol
severity: medium
category: security
is_workaround: false
subsystem: "src-tauri terminal/agent_manager (desktop NDJSON read path)"
evidence:
  - src-tauri/src/terminal/agent_manager/io_task.rs:424-429
  - src-tauri/src/terminal/agent_manager.rs:3029-3053
  - src-tauri/src/terminal/agent_manager/reattach.rs:228-236
  - audit/agent-protocol/0013-desktop-read-no-size-cap.md:14
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: previous-incomplete
previous_id: AGT-013
---

## What

AGT-013 was closed as already-on-develop because `core::ipc::read_line` is capped at 16 MiB and jsonrpc.rs `read_line_blocking` is test-only. The production path that actually reads agent stdout uses neither. io_task.rs appends every SSH Data chunk to `line_buf` with no size limit (line 424); `read_handshake_line` (agent_manager.rs:3035-3052) and reattach `drain_complete_lines` do the same. In addition, `line_buf.find('\n')` rescans the whole buffer on every chunk, and `line_buf = line_buf[pos + 1..].to_string()` (io_task.rs:429) reallocates and copies the remaining buffer for every line. Both are quadratic: a long response arriving in 32 KiB chunks, or a chunk holding many short notifications, costs O(n^2) CPU and copying.

## Why it matters

A compromised or buggy agent, or any stream with no newline, can grow desktop memory without limit, which is exactly the OOM vector AGT-013 described and believed closed. Even with a well-behaved agent, the quadratic rescans and copies on large file-read responses (up to the agent's 32 MiB response cap) and on output bursts waste CPU on the desktop's agent I/O task, which also carries every terminal session for that agent.

## Evidence

- `src-tauri/src/terminal/agent_manager/io_task.rs:424-429`
- `src-tauri/src/terminal/agent_manager.rs:3029-3053`
- `src-tauri/src/terminal/agent_manager/reattach.rs:228-236`
- `audit/agent-protocol/0013-desktop-read-no-size-cap.md:14`

## Recommendation

Replace the three ad-hoc accumulators with one byte-level line splitter that has a cap (reuse `core::ipc` `LineOutcome` semantics or a tokio_util `LinesCodec` with `max_length`). Keep a scan offset so each chunk is searched only once, use `drain(..=pos)` or a `VecDeque`/`BytesMut` instead of re-allocating the tail, and treat an over-cap line as a protocol error that tears down the agent connection. This can be done in the same change as the UTF-8 fix (AGT2-001).

## Verification

Confirmed. io_task.rs:424 pushes every Data chunk uncapped, and line 429 copies the tail once per line. `read_handshake_line` (agent_manager.rs:3035-3052) and reattach `drain_complete_lines` use drain, so they are only linear, but they are still unbounded. The AGT-013 resolution only examined `core::ipc::read_line` and `read_line_blocking`, never this russh channel path, which is the real one. A compromised agent can still send a newline-less line and exhaust desktop memory. Medium, same as AGT-013, because it needs a compromised or buggy agent.
