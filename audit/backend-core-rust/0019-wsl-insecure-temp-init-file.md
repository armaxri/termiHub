---
id: CORE-019
title: WSL init uses a predictable shared /tmp file — race / spoofing risk
angle: backend-core-rust
severity: medium
category: security
is_workaround: false
subsystem: core/backends/wsl
evidence:
  - core/src/backends/wsl.rs
status: open
---

## What
The WSL backend writes shell init to a fixed, predictable path (reported as
`/tmp/.termihub_init`) rather than a per-session unpredictable temp file.

## Why it matters
A fixed world-readable/writable `/tmp` path inside the WSL distro is a classic
symlink/pre-creation race: another local user or process in the distro can
pre-create or symlink the path to redirect or read the init content (which may
carry environment/command context), or race two concurrent WSL sessions writing
the same file.

## Evidence
`core/src/backends/wsl.rs` (init-file creation on spawn). Confirm the exact path
and permissions; compare with how SSH `sftp_ops` generates `/tmp/termihub-<uuid>`
safely.

## Recommendation
Use an unpredictable per-session name (uuid), create with `O_EXCL` and
`0600`, and clean it up on disconnect — mirroring the SSH temp-file pattern.
