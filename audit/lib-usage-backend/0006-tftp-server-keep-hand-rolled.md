---
id: LIBBE-006
title: Embedded TFTP server hand-rolled over std UDP — keep-as-is defensible
angle: lib-usage-backend
severity: info
category: arch
is_workaround: false
subsystem: core/embedded_servers/tftp
evidence:
  - core/src/embedded_servers/tftp_server.rs:1
status: open
---

## What
`core/src/embedded_servers/tftp_server.rs` implements a minimal TFTP server
(RFC 1350: RRQ/WRQ, DATA/ACK/ERROR, 512-byte blocks, bounded retransmission)
directly over `std::net::UdpSocket`, one thread per transfer. The sibling HTTP
and FTP embedded servers, by contrast, are delegated to crates (`axum` +
`tower-http`, `libunftp` + `unftp-sbe-fs`). A TFTP crate exists (`async-tftp`),
so the buy-vs-build question is fair.

## Why it matters
Recorded as **info / keep-as-is** — the hand-roll is a reasonable call here:

- **RFC 1350 is small and stable.** The read/write opcode handling, 512-byte
  blocking, and retransmit ceiling are a bounded, well-understood surface — not
  the open-ended edge-case swamp (`ls -l`/DOS/MLSD listing dialects, HTTP range
  requests) that justified crates for the FTP and HTTP servers.
- **Runtime shape.** The embedded-server subsystem uses a blocking, thread-per-
  transfer + `AtomicBool` shutdown model with a `BindSignal` readiness handshake
  (GAP G3, #1145). `async-tftp` is tokio-async-shaped; adopting it would drag an
  async runtime into a subordinate feature whose siblings are structured around
  the blocking lifecycle plumbing, for little correctness gain.
- It is bounded (`MAX_RETRIES`, `BLOCK_SIZE`) and confined to a
  user-opt-in hosting feature, not on the hot path.

This is the inverse of LIBBE-0001/0002: there, a crate was already in-tree and
strictly better; here, adopting a crate would fight the surrounding architecture
for a protocol simple enough to own.

## Evidence
`core/src/embedded_servers/tftp_server.rs:1-60` (opcodes, block size, retry cap,
bind-and-signal). Contrast `core/Cargo.toml:181-192` where HTTP/FTP explicitly
pull `axum`/`tower-http` and `libunftp`/`unftp-sbe-fs`, with the comment "The TFTP
server is hand-rolled over std UDP (RFC 1350) — no crate."

## Recommendation
**keep-as-is.** No change required for release. Revisit only if TFTP grows
options negotiation (RFC 2347/2348 blksize/tsize/timeout) — at that point the
edge-case surface tilts toward adopting `async-tftp`, provided the embedded-server
lifecycle is reconciled with its async model. Flagged to document the decision.
</content>
