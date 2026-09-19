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
status: fixed
resolution: "#3128 — plugin install/trust dialog warns on native code: warning callout (Cpu icon, --color-warning, testid plugin-install-native-warning) shown when a manifest declares terminalBackend (the one native extension = compiled Rust dylib) — states it runs UNSANDBOXED with full app privileges, can reach files/network/creds regardless of listed permissions. JS/JSON-only + blocked pkgs don't show it. pluginHasNativeCode() helper + tests. No sandboxing built (PLG-009 = maintainer)"
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
