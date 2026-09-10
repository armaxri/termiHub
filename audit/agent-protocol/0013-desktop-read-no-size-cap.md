---
id: AGT-013
title: Desktop-side NDJSON reads have no line-size cap — a compromised agent can OOM the desktop (asymmetric with the agent's 1 MiB cap)
angle: agent-protocol
severity: medium
category: security
is_workaround: false
subsystem: src-tauri/src/terminal/jsonrpc.rs, core/src/ipc/ndjson.rs
evidence:
  - src-tauri/src/terminal/jsonrpc.rs:150
  - core/src/ipc/ndjson.rs:35
status: open
---

## What
The agent's inbound NDJSON transport enforces a 1 MiB per-line cap while reading, rejecting
oversize lines without ever buffering them (`agent/src/io/transport.rs`, the #2352 fix —
correctly done). The **desktop** side reading the agent's output has no such bound:
- `read_line_blocking` (`src-tauri/src/terminal/jsonrpc.rs:150`) reads bytes one at a time
  into an unbounded `Vec` until a newline — no size limit.
- `core::ipc::read_line` (`core/src/ipc/ndjson.rs:35`) delegates to
  `AsyncBufReadExt::read_line` with no cap (this is the unbounded-read the core expert
  flagged; it feeds the desktop spawn IPC and any NDJSON consumer).

So a malicious or compromised agent (or a MITM who has broken the SSH channel) can send a
single newline-less multi-gigabyte line and drive the desktop to OOM. The protection is
asymmetric: the agent defends itself, the desktop does not defend against the agent.

## Why it matters
The trust model assumes the agent is trusted because it is reached over authenticated SSH.
But the agent runs on a remote host the user may not fully control (a shared server, a
device), and the update mechanism (AGT-003…008) makes agent compromise a realistic path.
A compromised agent should not be able to crash the desktop. The 1 MiB message cap is a
documented protocol rule (`docs/remote-protocol.md:132`) that both directions should honor.

## Evidence
- `src-tauri/src/terminal/jsonrpc.rs:150-162` — unbounded byte-at-a-time accumulation.
- `core/src/ipc/ndjson.rs:35-41` — `read_line` with no cap.
- Contrast: `agent/src/io/transport.rs` `read_ndjson_line` enforces `MAX_LINE_SIZE`.

## Recommendation
Apply the same 1 MiB cap on the desktop read path (reuse/port the agent's bounded
`read_ndjson_line`, or add a cap to `core::ipc::read_line` and `read_line_blocking`).
Reject and disconnect on an oversize line rather than buffering it.
