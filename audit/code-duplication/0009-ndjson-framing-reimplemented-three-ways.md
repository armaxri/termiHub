---
id: DUP-009
title: NDJSON line framing/reassembly is implemented three separate ways
angle: code-duplication
severity: medium
category: reliability
is_workaround: false
subsystem: core/ipc/ndjson vs agent/io/transport vs src-tauri/terminal/agent_manager
evidence:
  - core/src/ipc/ndjson.rs:35
  - agent/src/io/transport.rs:150
  - src-tauri/src/terminal/agent_manager.rs:1788
  - src-tauri/src/terminal/agent_manager.rs:2146
status: open
---

## What

Reading newline-delimited JSON off a byte stream exists in three independent implementations:

1. `core::ipc::ndjson::read_line`/`write_line` — a thin wrapper over tokio `read_line`. Used by the
   *local* projection IPC (`spawn/ipc_*`), the registry daemon, and the daemon transport.
2. `agent::io::transport::read_ndjson_line` — a robust hand-written reader that reassembles a line
   split across reads and enforces a 1 MiB size cap (rejects + recovers on oversize). **Agent-local,
   not in core.**
3. Desktop: `read_handshake_line` (accumulate `ChannelMsg::Data` until `\n`) and the main relay loop
   (`line_buf.push_str(...)` then `while let Some(pos) = line_buf.find('\n')`) — hand-rolled over the
   ssh2 channel in `agent_manager.rs`, with **no size cap**.

## Why it matters

The desktop↔agent channel is framed by the hand-rolled #3, which does not enforce the 1 MiB line cap
that the agent's #2 enforces on the reverse direction — an asymmetry in a transport invariant. The
most correctness-hardened implementation (#2: fragment reassembly + size cap + oversize recovery,
with its own test suite) lives in the agent where the desktop cannot reuse it, so the desktop
re-derived a weaker version. Framing bugs here manifest as truncated/merged JSON-RPC messages.

## Evidence

- `core/src/ipc/ndjson.rs:35` — `read_line` (tokio wrapper); `:18` `write_line`.
- `agent/src/io/transport.rs:150` — `read_ndjson_line` (reassembly + `MAX_LINE_SIZE` cap at :11);
  tested at `:247-360`.
- `src-tauri/src/terminal/agent_manager.rs:1788-1800` — `read_handshake_line` (`buf.find('\n')`).
- `src-tauri/src/terminal/agent_manager.rs:2143-2146` — main loop `push_str` + `find('\n')`, no cap.

## Recommendation

Promote the robust `read_ndjson_line` (fragment reassembly + shared size cap + oversize recovery)
into `core::ipc::ndjson` as the single framing primitive, expressed over `AsyncRead` (and, where the
ssh2 channel isn't an `AsyncRead`, a small `push(bytes) -> Iterator<lines>` state machine both the
async and the ChannelMsg paths can drive). Have all three consumers use it, so the 1 MiB cap is
enforced identically in both directions.
