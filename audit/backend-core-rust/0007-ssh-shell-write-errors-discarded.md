---
id: CORE-007
title: SSH shell-channel write/resize errors are silently discarded, losing input without teardown
angle: backend-core-rust
severity: medium
category: reliability
is_workaround: false
subsystem: core/backends/ssh
evidence:
  - core/src/backends/ssh/connector.rs:312
  - core/src/backends/ssh/connector.rs:315
status: open
---

## What
In the interactive shell-channel task, the result of writing data (and of
resizing) to the channel is dropped:

```rust
Some(ChannelCmd::Write(data)) => {
    let _ = channel.data(&data[..]).await;
}
Some(ChannelCmd::Resize(cols, rows)) => {
    let _ = channel.window_change(cols, rows, 0, 0).await;
}
```

## Why it matters
The write closure checks an `alive` flag before enqueuing, but the actual
`channel.data(...)` result is discarded. If a write fails (server-side
flow-control or transport error) while `alive` is still set, the user's
keystrokes are lost silently — no error is surfaced and the session is not torn
down, so the terminal appears live but swallows input. The resize arm has the
same issue.

## Evidence
`core/src/backends/ssh/connector.rs:310-322`.

## Recommendation
On a `channel.data` / `window_change` error, clear `alive` and break the task so
the session is torn down and the failure surfaces to the user, rather than
silently dropping input.
