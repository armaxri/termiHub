---
id: PERF-012
title: Output reader copies each 4 KB PTY read at least twice before emit
angle: performance
severity: low
category: perf
is_workaround: false
subsystem: core/src/backends, src-tauri/src/session/manager.rs
evidence:
  - core/src/backends/local_shell.rs:548
  - core/src/output/coalescer.rs:22
  - src-tauri/src/session/manager.rs:1888
status: open
---

## What
On the terminal-output hot path each 4 KB PTY read is heap-copied at least twice before it
leaves the backend: the reader thread does `buf[..n].to_vec()` (fresh `Vec` per read), the
coalescer then `extend_from_slice`s that into its pending buffer, and each emit additionally
clones the `session_id` `String` and allocates a fresh base64 `String`. Every backend
(local_shell, ssh, telnet, serial, wsl, docker) uses the identical pattern.

## Why it matters
This is not a structural problem — the coalescer batches, base64 is already the efficient
encoding (PERF is elsewhere), and per-read allocations are small — but under a sustained
firehose (e.g. `yes`, a large `cat`, verbose build output) it is steady allocator churn:
two copies of every byte plus two `String` allocations per emit, on the async runtime. It is
listed for completeness as the lowest-hanging micro-optimization on the busiest path.

## Evidence
- `core/src/backends/local_shell.rs:543,548,553` — `let mut buf = [0u8; 4096]; ... let data = buf[..n].to_vec(); ... sender.blocking_send(data)` (per-read alloc+copy); same shape in `ssh/mod.rs:623-647`, `telnet.rs:326-374`, `serial.rs`, `wsl.rs:857-891`, `docker/mod.rs:754-835`.
- `core/src/output/coalescer.rs:22` — `pending.extend_from_slice(data)` copies each chunk again.
- `src-tauri/src/session/manager.rs:1888` — `session_id.clone()` per emitted event; base64 encode allocates a new `String` per emit (`manager.rs:80`).

## Recommendation
- Low priority. If profiling shows allocator pressure under firehose output, consider a
  reusable/pooled read buffer and `bytes::Bytes` (ref-counted, cheap clone) to avoid the
  reader→coalescer copy, and pass the `session_id` as an `Arc<str>` to drop the per-emit
  `String` clone. Only worth doing if measurements justify it.
</content>
</invoke>
