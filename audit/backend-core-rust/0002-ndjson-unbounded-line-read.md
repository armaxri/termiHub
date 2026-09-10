---
id: CORE-002
title: NDJSON read_line has no maximum line length — unbounded memory on hostile input
angle: backend-core-rust
severity: high
category: reliability
is_workaround: false
subsystem: core/ipc/ndjson
evidence:
  - core/src/ipc/ndjson.rs:35
status: in-progress
resolution: "#2725"
---

## What
`ndjson::read_line` delegates straight to `AsyncBufReadExt::read_line` with no
cap on the line length:

```rust
pub async fn read_line<R>(reader: &mut R, buf: &mut String) -> io::Result<usize>
where
    R: AsyncBufRead + Unpin + ?Sized,
{
    buf.clear();
    reader.read_line(buf).await
}
```

`read_line` grows `buf` until it sees a `\n` or hits EOF. A peer that never
sends a newline forces `buf` to grow without bound.

## Why it matters
This is the shared framing for both the desktop↔agent JSON-RPC transport (over
SSH, i.e. across a trust boundary — a compromised/hostile agent or a MITM on the
channel) and the local spawn IPC. A single frame with no newline drives
allocation until the process OOMs — a trivial denial of service against a
safety-critical app, with no timeout or size ceiling to bound it. NDJSON is a
line protocol precisely so a bound is cheap to enforce.

## Evidence
`core/src/ipc/ndjson.rs:35-41`. There is no `take`/limit anywhere in the read
path; every caller inherits the unbounded behaviour. Legitimate frames are
small JSON objects, so a generous cap (e.g. a few MiB) never rejects real
traffic.

## Recommendation
Wrap the read in a bounded reader (`reader.take(MAX_LINE_BYTES)`) or read byte
manually up to a cap and return an `io::Error` (e.g. `InvalidData`) once the cap
is exceeded, so an oversized frame is rejected instead of buffered. Pick one
shared constant (also relevant to the "1 MiB line-cap constant" duplication
noted by the code-duplication angle). Add a test feeding a long newline-less
stream and asserting a bounded error rather than growth.
