---
id: DUP-004
title: agent-forward 64 KiB CHUNK_SIZE is duplicated across desktop and agent with no shared source
angle: code-duplication
severity: medium
category: reliability
is_workaround: false
subsystem: src-tauri/terminal/agent_forward.rs vs agent/session/agent_forward.rs
evidence:
  - src-tauri/src/terminal/agent_forward.rs:38
  - agent/src/session/agent_forward.rs:69
  - agent/src/io/transport.rs:11
status: open
---

## What

The ssh-agent-forwarding relay defines `const CHUNK_SIZE: usize = 65536;` **independently on both
sides** of the transport, and the two are required to match. Both comments say so explicitly:
- desktop: *"matches the agent-side chunk so neither side exceeds the transport's NDJSON line cap."*
- agent: *"mirrors `JsonRpcOutputSink`'s 64 KiB chunk so a burst stays under the transport's 1 MiB
  NDJSON line cap."*

The invariant that binds them — chunk must stay under the 1 MiB NDJSON line cap
(`agent/src/io/transport.rs:11` `MAX_LINE_SIZE = 1_048_576`) — is itself expressed as three separate
literals in three files (see DUP-006).

## Why it matters

This is a cross-crate coupling of a protocol constant with no shared definition, kept correct only
by matching comments. If one side is bumped (e.g. to 1 MiB for throughput) without the other, a
forwarded ssh-agent burst can exceed the receiver's line cap and the transport rejects the frame —
a silent break in ssh-agent forwarding that only the CI-dark integration lane would catch.

## Evidence

- `src-tauri/src/terminal/agent_forward.rs:38` — `const CHUNK_SIZE: usize = 65536;`
- `agent/src/session/agent_forward.rs:69` — `const CHUNK_SIZE: usize = 65536;`
- `agent/src/io/transport.rs:11` — `const MAX_LINE_SIZE: usize = 1_048_576;` (the cap both chunks
  must respect).

## Recommendation

Define one `pub const AGENT_FORWARD_CHUNK_SIZE` (derived from, or asserted `<`, the shared NDJSON
line-cap constant) in the shared protocol home from DUP-001, and reference it from both sides. Put
the line-cap itself there too so the "chunk < cap" invariant is expressed once, ideally as a
`const` assertion.
