---
id: CORE-022
title: Embedded TFTP server spawns an unbounded thread per request
angle: backend-core-rust
severity: high
category: reliability
is_workaround: false
subsystem: core/embedded_servers/tftp
evidence:
  - core/src/embedded_servers/tftp_server.rs
status: fixed
resolution: "#2786 — MAX_CONCURRENT_TRANSFERS=64"
---

## What
Each incoming TFTP request spawns a new OS thread with no cap on concurrent
handlers (reported by the embedded-servers/network audit).

## Why it matters
An unauthenticated client can send a flood of RRQ/WRQ datagrams and spawn threads
without bound, exhausting host threads/memory — an amplification of the DoS
surface for a server that may run on a constrained remote agent.

## Evidence
`core/src/embedded_servers/tftp_server.rs` request-accept loop (`thread::spawn`
per datagram/session, no semaphore or pool).

## Recommendation
Bound concurrency with a fixed worker pool or a semaphore capping in-flight
transfers, and drop/queue excess requests rather than spawning unboundedly.
