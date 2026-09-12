---
id: CORE-006
title: SSH port parsing truncates numeric values > 65535 via `as u16`
angle: backend-core-rust
severity: medium
category: bug
is_workaround: false
subsystem: core/backends/ssh
evidence:
  - core/src/backends/ssh/mod.rs:147
status: fixed
resolution: "#2793 — parse_port_setting u16::try_from; >65535 → default 22 (matches string branch)"
---

## What
Numeric `port` values are cast to `u16` with a wrapping `as`:

```rust
let port: u16 = settings
    .get("port")
    .and_then(|v| {
        v.as_u64()
            .map(|n| n as u16)
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    })
    .unwrap_or(22);
```

`n as u16` truncates: `65536` → `0`, `70000` → `4464`.

## Why it matters
An out-of-range numeric port silently targets the wrong port instead of being
rejected. Behaviour is also inconsistent with the string branch: `s.parse::<u16>()`
correctly rejects overflow, so `"70000"` errors out (→ default 22) while `70000`
(numeric) wraps to 4464. Either way the connection silently goes somewhere the
user did not intend.

## Evidence
`core/src/backends/ssh/mod.rs:147-154`. Same wrapping-cast pattern was flagged
generally in port handling; here it is on the SSH connect path.

## Recommendation
Use `u16::try_from(n).ok()` and treat a failure as an invalid-config error (or
fall through to the string parse / default), so an out-of-range port is rejected
rather than silently rewritten. Audit other backends for the same `as u16`
pattern.
