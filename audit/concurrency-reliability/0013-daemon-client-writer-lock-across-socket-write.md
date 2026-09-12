---
id: CONC-013
title: DaemonClient holds the writer mutex across every socket write
angle: concurrency-reliability
severity: low
category: reliability
is_workaround: false
subsystem: agent/daemon/client
evidence:
  - agent/src/daemon/client.rs:181
  - agent/src/daemon/client.rs:206
  - agent/src/daemon/client.rs:277
  - agent/src/daemon/client.rs:332
  - agent/src/daemon/client.rs:368
status: open
---

## What

Every `DaemonClient` write path locks the `writer` `tokio::sync::Mutex` and holds the guard across
`protocol::write_frame_async(..).await` — `query_buffer` (181→185), `write_via_handle` (206→210),
`resize_via_handle` (220→225), `detach` (277→279), `close` (290→292), and the `ProcessHandle`
`write_input`/`resize`/`close` (332→336, 350→355, 368→370).

## Why it matters

This serialization is intentional (frame writes must not interleave on the socket), so it is
correct. But a **stalled** socket write (a daemon that stops reading, a full pipe) holds the writer
lock for its full duration, blocking every other frame sender on that connection — input, resize,
detach, and kill all queue behind one hung write. There is no write timeout, so a wedged daemon can
make `detach`/`close` (the teardown path) hang. Bounded to one session's daemon connection, hence
low severity.

## Evidence

```rust
let mut guard = self.writer.lock().await;
let writer = guard.as_mut().ok_or_else(...)?;
protocol::write_frame_async(writer, MSG_INPUT, data).await?;   // guard held across the socket write
```

## Recommendation

Correct to serialize, but add a write timeout (`tokio::time::timeout` around
`write_frame_async`) so a wedged daemon socket cannot hang input/detach/close indefinitely; on
timeout, mark the client dead so teardown proceeds. Optionally move framed writes behind a bounded
mpsc + single writer task so senders never block each other directly.
</content>
