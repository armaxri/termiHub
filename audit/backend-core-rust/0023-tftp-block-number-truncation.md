---
id: CORE-023
title: TFTP block numbering and terminating-block handling break for files ≥ 32 MiB
angle: backend-core-rust
severity: medium
category: bug
is_workaround: false
subsystem: core/embedded_servers/tftp
evidence:
  - core/src/embedded_servers/tftp_server.rs
status: open
---

## What
The TFTP server's block counter is a `u16` that is not handled for rollover, and
the transfer-termination logic (a final block strictly shorter than 512 bytes)
is reported as mishandled for exact-multiple-of-512 file sizes (embedded-servers
audit).

## Why it matters
RFC 1350 block numbers wrap at 65535; 65535 × 512 ≈ 32 MiB. Without rollover
handling, transfers past ~32 MiB corrupt or stall. A file whose size is an exact
multiple of the block size needs an explicit zero-length terminating block; if
that is skipped, the client waits forever for EOF.

## Evidence
`core/src/embedded_servers/tftp_server.rs` (block counter increment and the
`< 512` last-block check).

## Recommendation
Allow the `u16` block number to wrap (standard TFTP behaviour) and cover
transfers larger than 32 MiB; send an explicit final empty DATA block when the
file size is an exact multiple of the block size. Add tests at the 512-multiple
and 32 MiB boundaries.
