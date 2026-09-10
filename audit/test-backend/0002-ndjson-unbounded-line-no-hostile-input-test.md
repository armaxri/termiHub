---
id: TBE-002
title: NDJSON read_line has no length bound and no hostile-input test
angle: test-backend
severity: high
category: test-gap
is_workaround: false
subsystem: core/ipc/ndjson
evidence:
  - core/src/ipc/ndjson.rs:35
  - core/src/ipc/ndjson.rs:40
  - core/src/ipc/ndjson.rs:48
status: open
---

## What
`read_line()` delegates to `tokio::io::AsyncBufReadExt::read_line`, which grows `buf` until it
sees `\n` or EOF — **no maximum line length**. A peer (agent transport / spawn IPC) that sends a
gigabytes-long line with no newline drives an unbounded `String` allocation → OOM/DoS. Every unit
test in the module (ndjson.rs:48-109) covers only well-formed, small, newline-terminated input:
happy-path framing, partial-read reassembly, EOF. There is **no** test for a pathologically long
unterminated line, embedded interior newlines, or invalid UTF-8.

## Why it matters
This framing is shared by "the desktop spawn IPC and the agent's JSON-RPC transport" (module
docs, ndjson.rs:1-7) — both of which move data from a remote/less-trusted peer. An unbounded read
on a hostile stream is a classic remote-triggerable memory-exhaustion vector, and the test suite
gives false confidence because it only ever proves the cooperative case works.

## Evidence
- ndjson.rs:35-41 — `read_line` → `reader.read_line(buf)`, unbounded.
- ndjson.rs:48-109 — tests: `write_line_appends_single_newline_and_flushes`,
  `read_line_reads_one_framed_line`, `read_line_reassembles_partial_reads`,
  `read_line_returns_zero_at_eof`. All cooperative, all small.
- Contrast: `core/src/backends/rdp_sidecar/protocol.rs:54` *does* enforce a
  `MAX_MESSAGE_BYTES = 128 MiB` frame cap — NDJSON has no analog.

## Recommendation
Add a `max_line_bytes` cap (read via `take()`/`AsyncBufRead` limited reader) and a test that feeds
a >cap unterminated stream and asserts a bounded error rather than unbounded growth. Add tests for
interior-newline and non-UTF-8 input. Until bounded, treat every NDJSON consumer as exposed.
