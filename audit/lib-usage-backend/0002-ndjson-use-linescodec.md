---
id: LIBBE-002
title: Use tokio-util LinesCodec (already a dep) for bounded NDJSON framing instead of hand-rolled read_line
angle: lib-usage-backend
severity: medium
category: reliability
is_workaround: false
subsystem: core/ipc/ndjson
evidence:
  - core/src/ipc/ndjson.rs:35
  - core/Cargo.toml:85
status: in-progress
resolution: "#2725"
---

## What
`ipc::ndjson` hand-rolls newline-delimited framing over
`tokio::io::AsyncBufReadExt::read_line`, with no maximum line length:

```rust
pub async fn read_line<R>(reader: &mut R, buf: &mut String) -> io::Result<usize>
where R: AsyncBufRead + Unpin + ?Sized {
    buf.clear();
    reader.read_line(buf).await     // grows buf until '\n' or EOF — unbounded
}
```

`tokio-util` is **already a dependency** of `core`, `src-tauri`, and `agent`
(`tokio-util = { version = "0.7", features = ["rt"] }`), and its
`codec::LinesCodec` provides exactly this framing **with a built-in cap**:
`LinesCodec::new_with_max_length(n)` returns an `Err(LinesCodecError::MaxLineLengthExceeded)`
once a line exceeds `n` bytes, and pairs with `Framed`/`FramedRead` to give a
`Stream<Item = Result<String, _>>` over any `AsyncRead`.

## Why it matters
This is the shared framing for the **desktop↔agent JSON-RPC transport** (across a
trust boundary — over SSH, i.e. a potentially hostile or compromised agent, or a
MITM on the channel) and the local spawn IPC. A peer that never sends a newline
drives `buf` to grow without bound until the process OOMs — a trivial DoS against
a safety-critical app, with no size ceiling to stop it.

This is the buy-vs-build view of the same defect the backend-core angle filed as
**CORE-002**: the fix is not to hand-roll a byte-capped reader, but to adopt the
bounded line codec that is already sitting in the dependency tree. NDJSON is a
line protocol precisely so the cap is cheap and correct to enforce; `LinesCodec`
also gets the partial-read reassembly, the trailing-`\n` handling, and the
UTF-8-boundary edge cases right, all of which the current thin wrapper re-derives
by hand.

## Evidence
- `core/src/ipc/ndjson.rs:35-41` — the unbounded read path; every caller
  (agent JSON-RPC transport, spawn IPC) inherits it.
- `core/Cargo.toml:85`, `src-tauri/Cargo.toml:548`, `agent/Cargo.toml:410` —
  `tokio-util 0.7` already present, so `LinesCodec` is available with **no new
  crate**. (The `codec` feature must be enabled — currently only `rt` is on, so
  the change is `features = ["rt", "codec"]`, still no new dependency in the lock.)

## Recommendation
**adopt-existing.** Reframe the transport read side around
`tokio_util::codec::FramedRead::new(reader, LinesCodec::new_with_max_length(MAX_LINE_BYTES))`
and the write side around `LinesCodec` / the existing `write_line` (which is a fine
trivial helper and can stay). Pick one shared `MAX_LINE_BYTES` constant (a few
MiB — legitimate JSON-RPC frames are small); this is also the "1 MiB line-cap
constant" the code-duplication angle noted. Add a test feeding a long
newline-less stream and asserting a bounded `MaxLineLengthExceeded`-style error
rather than unbounded growth.

If a full `Framed` migration is judged too invasive for the current transport
loop shape, the minimal equivalent is `reader.take(MAX_LINE_BYTES).read_line(...)`
— but the codec is the library-first answer and gives the `Stream` abstraction
for free.
</content>
