---
id: CORE-004
title: SSH exec ignores ChannelMsg::ExitSignal — signal-killed command reads as exit 0
angle: backend-core-rust
severity: high
category: bug
is_workaround: false
subsystem: core/backends/ssh
evidence:
  - core/src/backends/ssh/exec.rs:143
  - core/src/backends/ssh/exec.rs:149
status: fixed
resolution: "#2722"
---

## What
The exec event drain matches `ExitStatus` but has no arm for `ExitSignal`, so a
command terminated by a signal falls through `_ => {}` and the captured exit
status keeps its default of `0`:

```rust
Some(ChannelMsg::ExitStatus { exit_status }) => {
    return Some(ExecEvent::Exit(exit_status as i32));
}
Some(ChannelMsg::Eof) => return Some(ExecEvent::Eof),
Some(ChannelMsg::Close) => return Some(ExecEvent::Closed),
None => return None,
_ => {}
```

## Why it matters
When a remote process dies from a signal, SSH sends `exit-signal`, not
`exit-status`. With no `ExitSignal` handling the exit code defaults to 0
(success). The privileged-write path `write_file_content_elevated` calls
`classify_sudo_result(stderr, 0)`, which treats exit 0 as success — so a `sudo`
file rewrite killed mid-write (OOM/SIGKILL/SIGTERM) is reported as a **successful
privileged write**. That is a silent data-integrity failure on a safety-critical
path.

## Evidence
`core/src/backends/ssh/exec.rs:130-152` (the drain loop). The default exit value
originates upstream where `SshExecOutput.exit_status` is initialised, and
`classify_sudo_result` keys success off a zero status.

## Recommendation
Add `Some(ChannelMsg::ExitSignal { .. }) => return Some(ExecEvent::Exit(<nonzero>))`
(or a dedicated `ExecEvent::Signal(name)`), and make signal termination a
non-zero/failed exit so elevated writes and other exec callers see the failure.
Add a regression test simulating an `exit-signal` channel message.
