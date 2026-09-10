---
id: CORE-024
title: TFTP server does not validate the peer TID — accepts spoofed/mixed packets
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
The TFTP handler does not verify that each subsequent DATA/ACK datagram comes
from the same source address/port (Transfer ID) that started the transfer
(embedded-servers audit).

## Why it matters
RFC 1350 requires binding a transfer to the peer's TID (source ip:port). Without
it, a third party can inject ACK/DATA packets to corrupt or hijack an in-flight
transfer, and stray datagrams from unrelated senders are accepted into the wrong
transfer.

## Evidence
`core/src/embedded_servers/tftp_server.rs` per-packet receive loop (source addr
not checked against the transfer's established peer).

## Recommendation
Record the peer `SocketAddr` on the first packet and drop any subsequent packet
whose source does not match (sending an error packet per the RFC).
