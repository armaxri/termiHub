---
id: SEC2-004
title: "Plugin runner inherits the host's stdout, which can give sandboxed code a read/write terminal descriptor"
angle: security
severity: low
category: security
is_workaround: false
subsystem: "core/src/plugin/sandbox/spawn.rs"
evidence:
  - core/src/plugin/sandbox/spawn.rs:202
  - core/src/plugin/sandbox/spawn.rs:258
  - plugin-runner/src/sandbox/linux.rs:478
  - plugin-runner/src/sandbox/linux.rs:801
status: fixed
resolution: "#4335 — the runner's stdout is the null device on every platform; no host descriptor but its channel reaches it"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The runner is started with `.stdout(Stdio::inherit())` on Unix (`ChildStdio::Inherit` on Windows), so plugin code gets fd 1 of the host. Landlock and Seatbelt restrict _opening_ paths, not I/O on inherited descriptors, and seccomp allows read/write/ioctl except TIOCSTI. When termiHub is started from a terminal (dev builds, Linux users launching from a shell, `termihub &`), fd 1 is usually the O_RDWR tty. The plugin can read() keystrokes typed into that terminal (racing the shell, e.g. a later sudo password), emit escape sequences into it, or issue other tty ioctls (TIOCLINUX on a VT console). When launched by the desktop, it can write arbitrary entries into the journald stdout stream.

## Why it matters

The sandbox is meant to leave the plugin only its IPC channel and passed bridge sockets. An inherited terminal is an unmediated channel the confinement layers don't cover. Impact is limited to terminal-launched sessions.

## Evidence

- `core/src/plugin/sandbox/spawn.rs:202`
- `core/src/plugin/sandbox/spawn.rs:258`
- `plugin-runner/src/sandbox/linux.rs:478`
- `plugin-runner/src/sandbox/linux.rs:801`

## Recommendation

Give the runner a piped stdout as well, forwarded line-by-line through the host the same way stderr already is (peer.rs forward_stderr with its line cap), or use Stdio::null(). Then no host-owned descriptor other than the IPC socket and /dev/null reaches the sandbox.

## Verification

Confirmed at spawn.rs:202 (.stdout(Stdio::inherit())) and in the Windows ChildStdio::Inherit path. The runner never redirects fd 1 (no stdout handling in plugin-runner/src). Seccomp allows read and ioctl except TIOCSTI. When termiHub is launched from a terminal, the inherited O_RDWR tty reaches sandboxed code. The impact is limited to terminal-launched sessions, so low.
