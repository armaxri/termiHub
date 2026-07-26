# termihub-plugin-api

The **stable ABI contract** for termiHub native (dynamically-loaded)
terminal-backend plugins. This crate is compiled into **both** the termiHub host
and every third-party plugin, so it is the shared boundary between them — and its
ABI stability is the whole point.

## What this crate is (and is not)

It defines the *contract*: the metadata a plugin reports, the session-config it
receives, the output channel it writes to, the backend trait it implements, and
the exported symbols its dynamic library must provide. It does **not** contain
the host-side loader (that lives in a separate crate/issue), and it links no
`libloading`.

## Why the boundary is hand-rolled `#[repr(C)]`

Rust has **no stable ABI**: the layout of `String`, `&[u8]`, `dyn Trait` fat
pointers, and most enums is not guaranteed across compiler versions or builds.
The plugin-system concept originally sketched returning
`*mut dyn PluginTerminalBackend` across `extern "C"` — this is **undefined
behavior**, because a `dyn` fat pointer's vtable layout is not guaranteed to
match between a host and a separately-compiled plugin.

Instead, everything that crosses the boundary is either a `#[repr(C)]` struct of
FFI-safe fields, or an **opaque handle** (`*mut c_void`) plus a `#[repr(C)]`
vtable / callback of `extern "C"` function pointers. No `dyn` pointer, `String`,
or allocator ever crosses. Every owned resource carries its own destructor
function pointer, so each side frees only what it allocated.

This is the hand-written opaque-handle C ABI sanctioned by the design correction
in issue #1990 (the alternative was the `abi_stable` crate). It was chosen to
keep this every-plugin-links-it crate free of a heavy dependency and its
version-pinning constraints, and because it maps directly onto the FFI-safety
acceptance test (`improper_ctypes`).

## Writing a plugin

1. Add `termihub-plugin-api` as a dependency and build a `cdylib`.
2. Implement `PluginTerminalBackend` for your session type
   (`write_input` / `resize` / `close` / `is_alive`).
3. Export the four `extern "C"` entry points (names live in
   `termihub_plugin_api::symbols`):

   | Symbol | Purpose |
   | --- | --- |
   | `termihub_plugin_abi_version` | Return `CURRENT_PLUGIN_API_VERSION` you built against. |
   | `termihub_plugin_init` | Fill an out `PluginInfo` with your metadata. |
   | `termihub_plugin_create_backend` | Build a backend from the borrowed config + host output sender; return it via `PluginBackend::from_boxed`. |
   | `termihub_plugin_shutdown` | Process-wide cleanup before unload. |

The host checks your reported ABI version against its own and refuses
incompatible plugins.

See the crate-level rustdoc for a complete, compiling round-trip example.

## Versioning

`CURRENT_PLUGIN_API_VERSION` is the machine-readable half of the compatibility
promise; the crate's semver is the other half. Bump both deliberately whenever
the ABI changes in a way that breaks previously-built plugins.
