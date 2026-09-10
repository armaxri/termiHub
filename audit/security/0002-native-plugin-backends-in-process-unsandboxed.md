---
id: SEC-002
title: Native plugin backends run in-process with full app privileges (inverted trust model)
angle: security
severity: high
category: arch
is_workaround: false
subsystem: core/src/plugin
evidence:
  - core/src/plugin/host.rs:258
  - core/src/plugin/security.rs:11
  - core/src/plugin/capabilities.rs:15
  - src/plugins/frontendPlugins.ts:107
status: open
---

## What

A native plugin ships a backend dynamic library (`.so`/`.dll`/`.dylib`) that the
host `dlopen`s into the **main app process** and drives through a C ABI
(`core/src/plugin/host.rs:258 load_backend_library`). Once loaded, the plugin's
code runs with the **full privileges of termiHub itself**: the whole address
space (including decrypted credentials, the SSH agent socket, `known_hosts`, the
webview), the entire filesystem, and the network — with no OS-level isolation.

The capability bridge (`capabilities.rs`) only mediates operations a *cooperating*
plugin voluntarily routes through it, and the module docs say so explicitly:

```rust
// core/src/plugin/capabilities.rs:15-19
//! It is **not** an OS sandbox — an in-process plugin could still bypass the
//! bridge with a direct syscall, which only OS-level isolation (out of scope,
//! no substrate today) could stop.
```
```rust
// core/src/plugin/security.rs:11-13
//! A native plugin backend runs as a dynamic library **in the host process**, so
//! the host cannot intercept a plugin's own syscalls.
```

The trust model is **inverted** relative to risk. The far *less* dangerous
frontend plugins (themes/JS widgets) are locked down — executed inside a
least-privilege Web Worker sandbox and gated behind an **explicit default-off
setting** (`src/plugins/frontendPlugins.ts:107`: "explicit, default-off setting.
When `enabled` is false this loads nothing"). Meanwhile the far *more* dangerous
native code path is fully trusted and load-time permission checks
(`terminal`/`filesystem` consistency) are the only gate — none of which constrain
what the loaded machine code can actually do.

## Why it matters

For a safety-critical release, "install a plugin" is effectively "grant arbitrary
code execution with access to all stored SSH credentials and every live session."
A malicious or supply-chain-compromised native plugin can read the credential
vault out of memory, exfiltrate keys via the SSH agent, tamper with live
ventilator sessions, or persist. Signature verification (SEC — signature.rs)
proves *provenance and integrity* but does nothing to *contain* a signed-but-evil
or signed-then-compromised publisher. The permission model
(`network`/`filesystem`/`terminal`) reads as a sandbox to users but enforces
nothing against direct syscalls, which is a dangerous false sense of safety.

## Evidence

- `core/src/plugin/host.rs:258-342` — `load_backend_library` `dlopen`s an arbitrary
  library into the process and resolves its entry points; comment at `:259`
  acknowledges "the irreducible unsafety of a plugin host."
- `core/src/plugin/capabilities.rs:15-19` — bridge is explicitly "not an OS sandbox."
- `core/src/plugin/security.rs:11-37` — enumerates what is *not* enforceable; the
  direct-syscall surface is "out of scope (concept Non-Goals)."
- `src/plugins/frontendPlugins.ts:107-109` — frontend plugins sandboxed + default-off,
  the opposite posture from native.

## Recommendation

This is an architecture decision that must be made consciously *before* a
ventilator-grade release, not discovered after. Options, roughly in order of rigor:

1. **Out-of-process native plugins** — run each native backend in a separate,
   OS-sandboxed child process (seccomp/AppContainer/sandbox-exec) and speak the
   existing capability bridge over IPC, so the mediation is actually enforced.
   This is the real fix that lets the permission model mean something.
2. If (1) is not feasible for 0.1.0: make native plugins **off by default behind an
   explicit, clearly-worded "runs unsandboxed with full app privileges"
   acknowledgement** (mirror the frontend default-off posture), require a trusted
   (pinned/bundled) signature to enable, and surface an unmistakable warning at
   install and enable time. The current `Untrusted` warning string is good but the
   default should be "cannot enable native plugins" rather than "accept the risk."
3. Document the residual risk in `SECURITY.md` regardless (see SEC-summary).
