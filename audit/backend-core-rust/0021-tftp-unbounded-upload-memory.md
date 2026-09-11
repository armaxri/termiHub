---
id: CORE-021
title: Embedded TFTP server buffers an entire client upload in memory (unauthenticated OOM)
angle: backend-core-rust
severity: high
category: reliability
is_workaround: false
subsystem: core/embedded_servers/tftp
evidence:
  - core/src/embedded_servers/tftp_server.rs
status: fixed
resolution: "#2786 — tftp streams upload/download + 100MiB max_transfer_bytes cap"
---

## What
The hand-rolled TFTP server's WRQ (write) path accumulates the whole uploaded
file into an in-memory `Vec` before writing it out, with no size ceiling
(reported by the embedded-servers/network audit).

## Why it matters
TFTP is unauthenticated by design. An embedded TFTP server (hostable on the
desktop or a remote agent) that buffers the full upload lets any client on the
network OOM the host by streaming an arbitrarily large file — a trivial
denial-of-service against a safety-critical process.

## Evidence
`core/src/embedded_servers/tftp_server.rs` (WRQ handler accumulation). No
`max_bytes` check before/while buffering.

## Recommendation
Stream each received DATA block straight to the destination file, and enforce a
configurable maximum transfer size, aborting the transfer (TFTP error packet)
once exceeded.
