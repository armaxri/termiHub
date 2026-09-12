---
id: CORE-035
title: bridge_list_dir joins entries with newlines, corrupting names that contain newlines
angle: backend-core-rust
severity: low
category: bug
is_workaround: false
subsystem: core/plugin
evidence:
  - core/src/plugin/capabilities.rs:472
status: fixed
resolution: "#2797 — plugin list_dir length-prefixed framing (host+SDK); newline-safe"
---

## What
The `bridge_list_dir` FFI capability returns directory entries by joining names
with `\n` into a single byte blob:

```rust
unsafe { out_entries.write(FfiOwnedBytes::from_vec(joined.into_bytes())) };
```

## Why it matters
A filename may legally contain a newline on Unix. Newline-joining makes such a
name split into two spurious entries on the plugin side, so a plugin sees a
directory listing that does not match reality — and a crafted filename can inject
extra "entries" into what the plugin parses. It is a lossy framing for
arbitrary-bytes names.

## Evidence
`core/src/plugin/capabilities.rs:448-472`.

## Recommendation
Use a length-prefixed or NUL-delimited encoding (or a count + per-entry length)
that is unambiguous for names containing any byte, and decode it symmetrically on
the plugin side.
