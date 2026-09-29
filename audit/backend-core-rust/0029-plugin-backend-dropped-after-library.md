---
id: CORE-029
title: PluginConnectionType drops the library before the backend it created — use-after-free
angle: backend-core-rust
severity: high
category: bug
is_workaround: false
subsystem: core/plugin
evidence:
  - core/src/plugin/connection.rs:57
  - core/src/plugin/connection.rs:74
status: fixed
resolution: "#2783 — plugin path-containment soundness"
---

## What
`PluginConnectionType` declares the `Arc<LoadedLibrary>` **before** the
`backend: Option<LoadedBackend>` it created:

```rust
pub struct PluginConnectionType {
    library: Arc<LoadedLibrary>,   // declared first → dropped first
    ...
    backend: Option<LoadedBackend>,  // declared later → dropped after `library`
    output_tx: Arc<Mutex<Option<OutputSender>>>,
}
```

Rust drops struct fields in **declaration order**, so `library` is dropped before
`backend`.

## Why it matters
`LoadedBackend` was created by the plugin's dynamic library and its
`Drop`/vtable code lives in that library's mapped memory. If the `Arc` refcount
hits zero, `library` (which `dlclose`s the plugin) is dropped first, then
`backend`'s destructor runs against **unmapped code** — a use-after-free /
segfault on plugin session teardown. The doc comment on the struct even states
the library must "stay mapped for as long as … any `LoadedBackend` it created is
alive", but the field order violates exactly that.

## Evidence
`core/src/plugin/connection.rs:57-79`.

## Recommendation
Reorder so `backend` is declared **before** `library` (drop backend first), or
give `LoadedBackend` an owned `Arc<LoadedLibrary>` clone so the library cannot be
unloaded while a backend exists. Add a test that drops a connected plugin type
and asserts no crash. Consider making the invariant explicit with a manual `Drop`.
