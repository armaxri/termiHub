---
id: CORE-001
title: sanitize_connection_name can panic on a multi-byte UTF-8 boundary
angle: backend-core-rust
severity: medium
category: bug
is_workaround: false
subsystem: core/output/session_log
evidence:
  - core/src/output/session_log.rs:254
status: open
---

## What
`sanitize_connection_name` caps the result at 64 **bytes** using `String::truncate`,
but `String::truncate` panics if the byte index does not fall on a UTF-8 char
boundary:

```rust
if out.len() > 64 {
    out.truncate(64);
}
```

`out.len()` is a byte length; a connection name whose 64th byte lands in the
middle of a multi-byte codepoint (any non-ASCII name — CJK, emoji, accented
Latin) will make `truncate(64)` panic.

## Why it matters
Connection names are user-controlled and freely contain non-ASCII text. Opening
a per-session log for such a connection (`default_log_filename` →
`sanitize_connection_name`) panics the thread performing the session-log setup.
On the agent this can take down a worker; on the desktop it aborts the session
start. It is a latent panic on a real, user-reachable path in a
"ventilator-grade" release.

## Evidence
`core/src/output/session_log.rs:253-256`:
```rust
out = out.trim_matches(|c| c == '_' || c == '.').to_string();
if out.len() > 64 {
    out.truncate(64);
}
```
No existing test exercises a multi-byte name longer than 64 bytes, so the panic
is uncovered.

## Recommendation
Truncate on a char boundary, e.g. build the string from
`name.chars().take(64)` while sanitizing, or use
`out.char_indices().nth(64).map(|(i, _)| i)` to find a safe cut index (or
`floor_char_boundary` once stable). Add a regression test with a 100-char
non-ASCII name.
