---
id: AGT-024
title: Persistent-session scrollback buffer capacity is wire-controlled and unclamped — a huge value OOMs the daemon, zero silently drops output
angle: agent-protocol
severity: low
category: reliability
is_workaround: false
subsystem: agent/src/daemon/process.rs, core/src/buffer/mod.rs
evidence:
  - agent/src/daemon/process.rs:58
  - core/src/buffer/mod.rs:22
  - agent/src/session/manager.rs:655
status: open
---

## What
The persistent-session ring-buffer capacity flows from the desktop
(`initialize.agentSettings.persistent_scrollback_buffer_size_mb` →
`set_persistent_buffer_size_bytes`, `agent/src/session/manager.rs:655`) into the daemon via
env and is parsed with `unwrap_or(DEFAULT)` and **no ceiling or floor**
(`agent/src/daemon/process.rs:58`). `RingBuffer::new` eagerly allocates that many bytes
(`core/src/buffer/mod.rs:22`, `HeapRb::<u8>::new(capacity)`). A huge value OOMs the daemon; a
`0` yields a zero-capacity ring so all buffered output is silently dropped (breaking
scrollback replay on reattach). No clamping anywhere in the path.

## Why it matters
A client-supplied allocation size with no bounds is a self-inflicted DoS and a silent
correctness failure at the low end. The agent's `initialize` handler already has a
`mb_to_bytes` floor of 64 KiB for its own buffer sizing (`agent/src/handler/dispatch.rs:339`)
but the daemon path does not share that clamp.

## Evidence
- `agent/src/daemon/process.rs:58-61` — env parse, `unwrap_or(DEFAULT)`, no clamp.
- `core/src/buffer/mod.rs:22-24` — eager allocation of the given capacity.

## Recommendation
Clamp the capacity to a sane `[min, max]` range at the daemon boundary (reuse the
`mb_to_bytes` 64 KiB floor and add an upper ceiling), rejecting or coercing out-of-range
values.
