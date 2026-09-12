---
id: SEC-010
title: RDP drive-redirection read allocates on an unbounded server-supplied length
angle: security
severity: low
category: security
is_workaround: false
subsystem: rdp-sidecar
evidence:
  - rdp-sidecar/src/drive.rs:824
status: open
---

## What

The RDP sidecar's drive-redirection `read_at` allocates a buffer sized directly by
a `u32` length field taken from an RDP server `DR_READ` request:

```rust
// rdp-sidecar/src/drive.rs:824-827
// length: u32 from the server's DR_READ request
let mut buf = vec![0u8; length as usize];
```

There is no cap check before the allocation, so a malicious/compromised RDP server
can request up to ~4 GiB per read.

## Why it matters

Lower impact than the VNC case (SEC-009) — the `u32` ceiling is ~4 GiB rather than
tens of GiB, drive redirection is opt-in, and it is in the sandboxed sidecar — but
it is still an attacker-controlled allocation across the trust boundary that can
be used to exhaust memory or amplify a DoS. For a ventilator-grade bar, every
wire-length-driven allocation should be bounded.

## Evidence

- `rdp-sidecar/src/drive.rs:824-827` — `vec![0u8; length as usize]` with `length`
  from the server's `DR_READ`, no `MAX_*` check.
- Contrast (done right): the sidecar's own MessagePack framing checks
  `len > MAX_MESSAGE_BYTES` before allocating (`core/src/backends/rdp_sidecar/protocol.rs:214`),
  and the agent daemon frame protocol checks `MAX_PAYLOAD_SIZE` (16 MiB). Apply the
  same discipline here.

## Recommendation

Clamp the requested read length to a reasonable maximum (drive reads are chunked;
a few MiB is ample) and reject or truncate anything larger, reading in bounded
chunks. Use `checked` arithmetic and treat an over-cap request as a protocol
error.
