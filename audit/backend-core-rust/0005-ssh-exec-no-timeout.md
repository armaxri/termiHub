---
id: CORE-005
title: ssh_exec_with_stdin has no timeout — a stalled server hangs exec callers indefinitely
angle: backend-core-rust
severity: high
category: reliability
is_workaround: false
subsystem: core/backends/ssh
evidence:
  - core/src/backends/ssh/exec.rs:161
status: open
---

## What
`ssh_exec_with_stdin` opens a channel and drains events until `Close`/`None`
with no time bound:

```rust
pub async fn ssh_exec_with_stdin(
    session: &SshSession,
    command: &str,
    stdin: &str,
) -> Result<SshExecOutput, CoreError> {
    let channel = session.channel_open_session().await ...?;
    let mut channel = RusshExecChannel(channel);
    run_exec(&mut channel, command, stdin).await
}
```

The monitoring loop wraps this call in `COLLECT_TIMEOUT`, but
`probe_exec_capability`, `has_exec_capability`, and
`write_file_content_elevated` call it directly with no timeout.

## Why it matters
A hostile or half-dead server that opens the channel but never sends
EOF/Close makes these operations (and their callers — capability probing during
connect, and privileged file writes) hang forever. There is no cancellation
token plumbed into the drain, so the task is stuck with no recovery.

## Evidence
`core/src/backends/ssh/exec.rs:130-171`. `run_exec` loops on
`next_event().await` with the only exits being server-sent `Close`/`None`.

## Recommendation
Wrap the drain in `tokio::time::timeout` (or plumb the caller's
`CancellationToken` into `run_exec`) so a stalled exec returns an error instead
of hanging. Apply a sensible default to all direct callers, not only the
monitoring loop.
