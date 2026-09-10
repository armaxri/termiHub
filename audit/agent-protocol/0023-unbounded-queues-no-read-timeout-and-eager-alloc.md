---
id: AGT-023
title: Registry has unbounded outbound queues, no frame read timeout (local slowloris), and eager 16 MiB per-frame allocation
angle: agent-protocol
severity: low
category: reliability
is_workaround: false
subsystem: agent/src/registry_daemon/process.rs, agent/src/daemon/protocol.rs
evidence:
  - agent/src/registry_daemon/process.rs:63
  - agent/src/daemon/protocol.rs:131
  - agent/src/daemon/process.rs:315
status: open
---

## What
Several unbounded/untimed resource paths in the local IPC layer (all within the same-user
trust boundary, hence low, but relevant to a long-uptime safety build):

1. **Unbounded registry outbound queues.** Each `WorkerConn.tx` is an
   `mpsc::unbounded_channel` (`agent/src/registry_daemon/process.rs:63`); `fan_out` clones
   each broadcast into every worker's queue. A worker whose writer is blocked (slow, not
   gone) accumulates queued frames without bound — a broadcast storm to a stalled recipient
   grows memory indefinitely.
2. **No frame read timeout (local slowloris).** No reader loop bounds how long a peer may
   take to deliver a frame (`agent/src/daemon/process.rs:315`,
   `agent/src/daemon/client.rs:484`, `agent/src/registry_daemon/process.rs:207`). A peer that
   writes a partial header then stalls parks the reader in `read_exact` forever, pinning the
   task (and, for the registry, its `WorkerConn` entry + unbounded queue). No
   heartbeat/liveness reaps a wedged-but-connected peer.
3. **Eager 16 MiB allocation per frame.** `agent/src/daemon/protocol.rs:131` does
   `vec![0u8; length]` up front for any length ≤ 16 MiB (the cap is correctly enforced before
   allocation — good). The registry accepts unbounded concurrent connections, so N same-user
   connections each declaring a 16 MiB frame is a 16 MiB×N amplification. Registry payloads
   are "a handful of small frames," so its per-connection ceiling should be far smaller than
   the session daemon's.

## Why it matters
None is remotely exploitable, but on a long-running host a stuck consumer or a wedged peer
leaks memory/tasks with no reaper — the kind of slow degradation a ventilator-grade uptime
target must avoid.

## Evidence
- `agent/src/registry_daemon/process.rs:63` — unbounded `WorkerConn.tx`.
- `agent/src/daemon/process.rs:315` / `client.rs:484` / `registry_daemon/process.rs:207` —
  `read_exact` with no timeout.
- `agent/src/daemon/protocol.rs:131` — eager `vec![0u8; length]`.

## Recommendation
Bound the registry outbound queues (drop-oldest or disconnect a slow consumer), add a
read/idle timeout + heartbeat to reap wedged peers, and give the registry a small
per-connection frame ceiling distinct from the session daemon's 16 MiB.
