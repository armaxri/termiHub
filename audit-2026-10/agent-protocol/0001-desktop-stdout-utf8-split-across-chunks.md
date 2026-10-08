---
id: AGT2-001
title: "Desktop decodes agent stdout one SSH chunk at a time with from_utf8_lossy, so non-ASCII text split across chunks is corrupted"
angle: agent-protocol
severity: medium
category: correctness
is_workaround: false
subsystem: "src-tauri terminal/agent_manager (desktop side of the agent NDJSON transport)"
evidence:
  - src-tauri/src/terminal/agent_manager/io_task.rs:424
  - src-tauri/src/terminal/agent_manager.rs:3052
  - agent/src/io/transport.rs:247
  - core/src/ipc/ndjson.rs:38
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The agent serialises every response and notification with `serde_json::to_string` (io/transport.rs:247). That leaves non-ASCII characters as raw multi-byte UTF-8; it does not escape them as `\uXXXX`. The desktop's I/O loop gets agent stdout as russh `ChannelMsg::Data` chunks and runs `line_buf.push_str(&String::from_utf8_lossy(data))` on each chunk separately (io_task.rs:424). `read_handshake_line`, which handles the handshake, reattach and reconnect reads, does the same (agent_manager.rs:3052). SSH channel chunk boundaries can fall anywhere, so when one lands inside a multi-byte character, each half of that character becomes U+FFFD before the line is put back together. The JSON still parses, but the string value is silently wrong.

## Why it matters

Text affected includes file and directory names in connection.files.list/stat, connections.list names and folders, process names, ki-prompt text and error messages. Large responses such as a big directory listing or connections.list span many 32 KiB SSH packets, so a split character is likely for users with umlauts, CJK or emoji in names (the project's own users). A corrupted name shows as garbage; renaming, deleting or opening it then fails with not-found. If the desktop saves a corrupted connection or folder name back through connections.update, the corruption is written into the agent's store permanently. No test covers a multi-byte character split across chunks.

## Evidence

- `src-tauri/src/terminal/agent_manager/io_task.rs:424`
- `src-tauri/src/terminal/agent_manager.rs:3052`
- `agent/src/io/transport.rs:247`
- `core/src/ipc/ndjson.rs:38`

## Recommendation

Buffer raw bytes rather than decoded text. Keep `line_buf` as a `Vec<u8>`, use memchr to find `b'\n'`, and decode only complete lines (`std::str::from_utf8`, or `serde_json::from_slice` directly). Do the same in `read_handshake_line`, and ideally share one helper between the two paths. Add a regression test that feeds a JSON line containing "Übersicht" split inside the 'Ü' across two Data chunks and checks the decoded string is unchanged.

## Verification

Confirmed. io_task.rs:424 lossy-decodes each `ChannelMsg::Data` chunk before newline splitting; `read_handshake_line` (agent_manager.rs:3052) does the same. The agent writes raw UTF-8 via `serde_json::to_string`, with no ASCII escaping anywhere in agent/src or core/src/ipc. No ADR or audit entry accepts this; the nearby comment at agent_manager.rs:3058 concerns stderr only. No test covers a mid-character split. Rated medium rather than high: chunks are ~32 KiB, so small responses arrive whole and the split mainly hits large listings with non-ASCII text, but when it happens names display wrong and later file operations fail with not-found. Persisting the corruption via connections.update requires a user saving the damaged entity. The fix is small.
