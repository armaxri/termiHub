---
id: SEC-003
title: Plugin filesystem-scope check is lexical-only and follows symlinks, allowing scope escape
angle: security
severity: medium
category: security
is_workaround: false
subsystem: core/src/plugin
evidence:
  - core/src/plugin/security.rs:219
  - core/src/plugin/security.rs:242
  - core/src/plugin/capabilities.rs:344
  - core/src/plugin/capabilities.rs:384
status: open
---

## What

`FilesystemScope::check()` authorizes a plugin-supplied path by **lexical**
normalization only — it collapses `.`/`..` textually and never touches the
filesystem, so it does not resolve symlinks:

```rust
// core/src/plugin/security.rs:219-232
let normalized = normalize_lexical(requested);
for root in &self.roots {
    if normalized == *root || normalized.starts_with(root) { return Ok(normalized); }
}
```
```rust
// core/src/plugin/security.rs:242 (doc)
/// Lexically normalize a path ... **without** touching the filesystem (no
/// symlink resolution).
```

The host bridge then performs the real I/O on that lexically-approved path with
ordinary, symlink-following calls: `std::fs::read` (`capabilities.rs:344`),
`OpenOptions::open` (`:384`), `metadata`, `read_dir`. If any component inside a
declared root is a symlink pointing outside the root, the check passes but the
read/write lands outside the scope.

## Why it matters

A plugin granted `filesystem` scope to, say, `<plugins>/acme/data` can create
`<plugins>/acme/data/link -> /` (or `-> ~/.ssh`) — writing that symlink is itself
in-scope — and then read `<plugins>/acme/data/link/.ssh/id_ed25519`, which
`starts_with` the root lexically but resolves to the user's private key. The same
trick enables writing outside the scope. This defeats the one filesystem
containment the bridge claims to provide.

The blast radius is bounded by SEC-002: a *native* plugin can bypass the bridge
entirely with a direct syscall, so for native plugins this is a second door into
a room whose wall is already missing. But the bridge is presented as the
enforcement boundary and is the path a **cooperating or a future out-of-process**
plugin would use, so the check must be sound on its own. It is also a
verify-then-use TOCTOU: even absolute-path canonicalization must be done and then
the *canonical* path used for the open.

## Evidence

- `core/src/plugin/security.rs:219-261` — `check()` + `normalize_lexical`, lexical only.
- `core/src/plugin/capabilities.rs:344` (`bridge_read_file`), `:384`
  (`bridge_write_file`), `:425` (stat), `:462` (list_dir) — I/O on the approved
  path with symlink-following std calls.
- The existing tests only cover textual `..` traversal
  (`security.rs:658 filesystem_scope_rejects_traversal_escape`); none create a
  symlink, so the gap is untested.

## Recommendation

Canonicalize the resolved path against the filesystem before the containment
check and use the *canonical* path for the actual I/O: `std::fs::canonicalize`
(or a `dunce`/`path-clean`+`canonicalize` combination) each declared root once,
canonicalize the requested path's existing prefix, and require the canonical
result to be contained in a canonical root. For not-yet-existing write targets,
canonicalize the parent directory and re-check. Alternatively open with
`O_NOFOLLOW` semantics on the final component and reject symlinked ancestors. Add
a regression test that plants an in-scope symlink to `/etc` (or `~/.ssh`) and
asserts the read/write is refused.
