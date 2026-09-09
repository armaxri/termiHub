---
id: PROD-050
title: Native plugins run in-process with no OS-level sandbox
angle: product-completeness
severity: medium
category: security
is_workaround: false
subsystem: core/plugin/capabilities
evidence:
  - core/src/plugin/capabilities.rs:16
status: open
---

## What
Native plugin backends (`.dll/.so/.dylib`) load in-process. The capability bridge mediates
cooperating calls but is explicitly "not an OS sandbox" — a native plugin can bypass it with a
direct syscall.

## Why it matters
The permission prompt implies containment; users may grant permissions believing the plugin is
sandboxed. A native backend actually has full process access. This is a security-expectation
gap worth surfacing clearly at install time.

## Evidence
- `core/src/plugin/capabilities.rs:16` — "not an OS sandbox — an in-process plugin could still bypass the bridge with a direct syscall."

## Recommendation
Make the install/trust dialog state plainly that native plugins are unsandboxed (trust = full
access); consider out-of-process/WASM execution for untrusted plugins long-term.
