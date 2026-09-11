---
id: CORE-030
title: Plugin filesystem scope check is lexical-only — a symlink inside a root escapes the sandbox
angle: backend-core-rust
severity: high
category: security
is_workaround: false
subsystem: core/plugin
evidence:
  - core/src/plugin/security.rs:219
  - core/src/plugin/security.rs:235
status: fixed
resolution: "#2783"
---

## What
`PathScope::check` authorizes a path by **lexical** normalization and a
`starts_with` root containment test, explicitly without resolving symlinks:

```rust
let normalized = normalize_lexical(requested);
for root in &self.roots {
    if normalized == *root || normalized.starts_with(root) {
        return Ok(normalized);
    }
}
```
and `normalize_lexical` is documented as "**without** touching the filesystem
(no symlink resolution)".

## Why it matters
This is the sandbox boundary for untrusted plugins' `bridge_read_file` /
`bridge_write_file` / `bridge_list_dir` capabilities. If a granted root contains
(or the plugin can create — it may have write capability) a symlink pointing
outside the root, the lexical check passes because the textual path stays under
the root, but the OS follows the link and the plugin reads/writes arbitrary files
(e.g. `~/.ssh/id_rsa`, credential stores). Lexical `..` collapsing does not
defend against symlinks.

## Evidence
`core/src/plugin/security.rs:212-241`. The containment test never canonicalizes.

## Recommendation
Canonicalize the requested path (`std::fs::canonicalize`, resolving symlinks) and
test the **canonical** path against canonical roots; for writes/creates, resolve
the parent and re-check. Alternatively open with `O_NOFOLLOW` semantics. Note the
TOCTOU: canonicalize-then-open still races, so open the file and verify via the
resulting fd where feasible.
