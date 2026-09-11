---
id: CORE-034
title: Plugin host verifies then loads the library as separate steps (TOCTOU) and picks it nondeterministically
angle: backend-core-rust
severity: medium
category: security
is_workaround: false
subsystem: core/plugin
evidence:
  - core/src/plugin/host.rs:261
  - core/src/plugin/manager.rs
status: in-progress
resolution: "#2797 — deterministic lib pick + re-hash before load; full TOCTOU closure residual → #2796"
---

## What
Two related issues in loading a plugin's native backend library (plugin/files
audit):
1. **TOCTOU:** the package/library is signature-verified and integrity-checked in
   one step, then `Library::new(library_path)` opens it in a later step against
   the on-disk path — an attacker who can replace the file between check and load
   bypasses verification (same shape as the RDP-sidecar finding, CORE-011).
2. **Nondeterministic selection:** `find_backend_library` picks the backend
   dynamic library from a directory scan whose ordering is not deterministic, so
   which file loads (when more than one matches) is unpredictable.

## Why it matters
This gates loading arbitrary native code into the app's address space — the
highest-trust operation the plugin system performs. A verify/load gap or an
ambiguous "which .so did we actually load" both undermine the guarantee that the
loaded code is the code that was verified.

## Evidence
`core/src/plugin/host.rs:261` (`unsafe { Library::new(library_path) }`), and the
directory scan in `find_backend_library` / `manager.rs`.

## Recommendation
Verify the exact bytes that are loaded: hash/verify an opened handle and load from
that same handle/absolute path with no re-lookup. Make library selection
deterministic (explicit manifest-declared filename; reject ambiguity) rather than
relying on scan order.
