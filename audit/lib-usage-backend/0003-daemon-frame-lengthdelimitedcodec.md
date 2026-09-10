---
id: LIBBE-003
title: Daemon binary frame protocol could use tokio-util LengthDelimitedCodec (borderline — keep-as-is defensible)
angle: lib-usage-backend
severity: low
category: arch
is_workaround: false
subsystem: agent/daemon/protocol
evidence:
  - agent/src/daemon/protocol.rs:110
  - agent/src/daemon/protocol.rs:149
status: open
---

## What
`agent::daemon::protocol` hand-rolls a length-prefixed binary frame:
`[type: 1 byte][length: 4 bytes BE][payload: length bytes]`, with sync + async
read/write halves that manually `read_exact` the 5-byte header, decode the BE
length, enforce a 16 MiB `MAX_PAYLOAD_SIZE` guard, then `read_exact` the payload.

`tokio-util::codec::LengthDelimitedCodec` (from the `tokio-util` crate already in
the tree) implements the length-prefix framing, the configurable max-frame guard,
and the partial-read buffering that the async path here re-derives by hand
(`read_frame_async`, `write_frame_async`).

## Why it matters
This is a **genuine borderline case**, recorded for completeness rather than as a
clear defect:

- The repo's own `.claude/CLAUDE.md` explicitly lists the "daemon binary frame
  protocol" as acceptable **domain-specific glue** with no library analog. The
  1-byte message-type discriminant prepended to each frame is not something
  `LengthDelimitedCodec` models directly (it framing-prefixes length only), so a
  codec adoption would still hand-roll the type byte on top.
- The code is **well tested** (round-trips for every message type, EOF handling,
  truncated-payload handling, a 100 KB payload) and already has the max-size
  guard that the NDJSON path (LIBBE-002) is missing.
- Against that: the manual `read_exact` framing is the class of code where a codec
  earns its keep — `LengthDelimitedCodec` + `Framed` give correct buffering and
  cancellation-safety, and the type byte folds cleanly into the payload's first
  byte (or a thin `Encoder`/`Decoder` wrapper).

## Evidence
`agent/src/daemon/protocol.rs:110-164` (async read/write), guard at :124-129,
header pack/unpack at :114-122 / :153-157. `tokio-util 0.7` is a dependency of
`agent` (`agent/Cargo.toml:410`); `LengthDelimitedCodec` needs the `codec` feature
enabled.

## Recommendation
**keep-as-is (defensible), optional adopt.** Do **not** treat this as
release-blocking. If the daemon transport is ever refactored, the tidy form is a
small `tokio_util::codec::{Decoder, Encoder}` over `LengthDelimitedCodec` that
carries the 1-byte type in the frame body — that removes the hand-written
`read_exact` framing while keeping the compact binary wire format the comment
rightly wants. Absent such a refactor, the current implementation is correct,
bounded, and tested, and the repo has already blessed it as domain glue; leaving
it alone is a reasonable call.
</content>
