---
id: CORE-036
title: FFI bridge context<'a> hands out an unbounded-lifetime reference to plugin-owned pointer
angle: backend-core-rust
severity: medium
category: bug
is_workaround: false
subsystem: core/plugin
evidence:
  - core/src/plugin/capabilities.rs:263
status: open
---

## What
The bridge helper reconstructs a `&BridgeContext` from a raw `*mut c_void`
supplied by the plugin, with a caller-chosen (effectively unbounded) lifetime:

```rust
unsafe fn context<'a>(ctx: *mut core::ffi::c_void) -> &'a BridgeContext {
    ...
    unsafe { &*ctx.cast::<BridgeContext>() }
}
```

## Why it matters
`'a` is unconstrained, so the borrow checker cannot tie the returned reference's
lifetime to the actual validity of the `ctx` allocation. The pointer originates
across the C ABI from the plugin; a null, dangling, or wrong-type pointer (buggy
or malicious plugin) yields undefined behaviour, and the unbounded lifetime lets
the reference outlive a concurrent `bridge_destroy` (`Box::from_raw` on the same
ctx), a potential use-after-free/data race. The other `unsafe extern "C"` bridge
fns build on this.

## Evidence
`core/src/plugin/capabilities.rs:263-267`, used by `bridge_open_connection`,
`bridge_read_file`, `bridge_write_file`, `bridge_stat_path`, `bridge_list_dir`;
freed by `bridge_destroy` (`:484-488`).

## Recommendation
Document and enforce the ctx-validity contract: null-check the pointer, keep the
returned reference's scope local (do not leak it past the call), and ensure the
lifecycle guarantees `destroy` cannot race a live borrow (e.g. the host owns ctx
lifetime, not the plugin). Consider passing an integer handle indexed into a
host-side table instead of a raw pointer.
