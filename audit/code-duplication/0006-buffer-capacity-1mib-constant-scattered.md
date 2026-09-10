---
id: DUP-006
title: The 1 MiB buffer / line-cap constant is redeclared instead of reusing core::buffer
angle: code-duplication
severity: low
category: arch
is_workaround: false
subsystem: core/buffer vs agent (daemon, session, io)
evidence:
  - core/src/buffer/mod.rs:7
  - agent/src/daemon/process.rs:22
  - agent/src/session/manager.rs:338
  - agent/src/io/transport.rs:11
status: open
---

## What

`core::buffer::DEFAULT_BUFFER_CAPACITY = 1_048_576` (1 MiB) is the intended shared ring-buffer size,
but the agent redeclares the same magic literal in its own constants instead of importing it:
`DEFAULT_BUFFER_SIZE` (daemon), `DEFAULT_PERSISTENT_BUFFER_SIZE` (session manager), and the NDJSON
`MAX_LINE_SIZE` transport cap. The `agent_forward` chunk (DUP-004) is sized against this same
1 MiB cap. The value therefore appears as an unlinked `1_048_576` literal in several files.

## Why it matters

Low blast radius, but these constants are semantically linked (ring-buffer capacity, persistent
buffer, transport line cap, forward chunk) and drift independently. A change to the buffer sizing
policy touches several files with no compiler linkage. It also obscures which of these are the
*same* budget vs coincidentally equal.

## Evidence

- `core/src/buffer/mod.rs:7` — `pub const DEFAULT_BUFFER_CAPACITY: usize = 1_048_576;`
- `agent/src/daemon/process.rs:22` — `const DEFAULT_BUFFER_SIZE: usize = 1_048_576;`
- `agent/src/session/manager.rs:338` — `const DEFAULT_PERSISTENT_BUFFER_SIZE: usize = 1_048_576;`
- `agent/src/io/transport.rs:11` — `const MAX_LINE_SIZE: usize = 1_048_576;`

## Recommendation

Have the agent's buffer constants reference `core::buffer::DEFAULT_BUFFER_CAPACITY`. Put the NDJSON
transport line-cap in the shared protocol/ipc home (it is a protocol invariant, not a buffer size)
and reference it from both the agent transport and the desktop framing (DUP-009). Where two values
are deliberately independent, name them so, rather than repeating the same literal.
