---
id: CORE-014
title: RDP clipboard fetch can loop forever on zero-length non-final chunks
angle: backend-core-rust
severity: medium
category: reliability
is_workaround: false
subsystem: core/backends/rdp_sidecar
evidence:
  - core/src/backends/rdp_sidecar/mod.rs:753
status: fixed
resolution: "#2804 — rdp clipboard: plan_clipboard_chunk guard rejects zero-len non-final + bounds chunk count (no infinite loop)"
---

## What
The clipboard-fetch loop counts only `data.len()` toward its size cap and
terminates only on the `last` flag:

```rust
if let Some(max) = cap {
    if written.saturating_add(data.len() as u64) > max {
        return Err(io_error("clipboard file exceeded its advertised size".to_string()));
    }
}
file.write_all(&data)...;
written += data.len() as u64;
if last { ... return Ok(staged); }
```

## Why it matters
A chunk with `data = []` and `last = false` leaves `written` unchanged, so the
size cap (which only counts `data.len()`) is never tripped and the loop makes no
progress. A buggy or compromised sidecar can stream empty non-final chunks
indefinitely, hanging the fetch with no progress and no timeout.

## Evidence
`core/src/backends/rdp_sidecar/mod.rs:753-782`.

## Recommendation
Reject a zero-length non-final chunk, or bound the total number of chunks / add a
no-progress timeout.
