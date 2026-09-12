---
id: TAURI-014
title: Unbounded channels in agent forwarding / local-process output (no backpressure)
angle: backend-tauri-rust
severity: low
category: reliability
is_workaround: false
subsystem: terminal/agent_forward / commands/local_process
evidence:
  - src-tauri/src/terminal/agent_forward.rs:90
  - src-tauri/src/terminal/agent_manager.rs:848
  - src-tauri/src/commands/local_process.rs:306
status: open
---

## What

Several producer→consumer paths use `tokio::sync::mpsc::unbounded_channel`, which has no
backpressure: if the consumer stalls or is slower than the producer, the queue grows without
bound and consumes memory until the producer stops or the process is OOM-killed.

- `terminal/agent_forward.rs:90` — `unbounded_channel::<Vec<u8>>()` per forwarded ssh-agent
  stream; bytes from the agent are `tx.send()` with the result discarded (`on_data`, line ~102).
- `terminal/agent_manager.rs:848` — `unbounded_channel::<AgentIoCommand>()` for the agent I/O
  command loop.
- `commands/local_process.rs:306` — `unbounded_channel::<(&'static str, String)>()` for
  local-process stdout/stderr lines.

The ssh-agent forwarding path is bounded in practice by the SSH-agent request/response protocol
(small, request-driven), so its blast radius is limited. The agent-I/O and local-process output
paths are the ones where a fast/verbose producer against a slow consumer can accumulate.

## Why it matters

Unbounded queues are a latent memory-exhaustion vector under adverse conditions (a chatty
remote, a wedged frontend consumer, a process spewing output faster than it is drained). For a
safety-critical build that should stay up indefinitely, unbounded buffering is a reliability
smell even if no path exercises it today.

## Evidence

- `agent_forward.rs:90` + `:102` (`let _ = tx.send(data);` — send result ignored, no bound).
- `agent_manager.rs:848`.
- `local_process.rs:306`.

## Recommendation

Audit each unbounded channel for whether its producer is naturally bounded. For the ones that
are not (agent I/O output, local-process output), switch to a bounded `mpsc::channel(N)` with an
explicit overflow policy — apply backpressure to the producer where possible, or drop-oldest
with a logged warning where the stream is advisory. Document why any remaining
`unbounded_channel` is safe (i.e. its producer is protocol-bounded), the way the codebase
documents its other invariants.
</content>
