---
id: PROD2-003
title: "README still warns that native plugins run with full user privileges, contradicting the sandbox (ADR-19)"
angle: product-completeness
severity: low
category: docs
is_workaround: false
subsystem: "README / plugin sandbox UX"
evidence:
  - README.md:152
  - README.md:124
  - docs/architecture.md:3456
  - src/components/Plugins/PluginInstallDialog.tsx:252
  - core/src/plugin/native_trust.rs
status: fixed
resolution: "#4317 — README trust warning rewritten for the sandbox, linking SECURITY.md and plugin-authoring.md"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

README.md:152 says native plugins "run arbitrary code with your full user privileges" and that "An untrusted native plugin can do anything your user account can." README.md:124 describes native backends as "loaded over a C ABI" without mentioning the sandbox. Since #4189 (ADR-19) every native plugin runs in a sandboxed termihub-plugin-runner (landlock/seccomp, Seatbelt, LPAC). The in-app copy was updated to say so: the install dialog reads "Native code — runs sandboxed", and NATIVE_TRUST_DISCLOSURE and the settings registry say the same.

## Why it matters

The README is the first product description users and plugin authors read. It now contradicts the app and the headline security property of the sandbox work, and it overstates the risk in a way that conflicts with the trust dialog. The remaining real caveats are reduced isolation when a layer is missing, and that a plugin still controls what it draws in its own terminal.

## Evidence

- `README.md:152`
- `README.md:124`
- `docs/architecture.md:3456`
- `src/components/Plugins/PluginInstallDialog.tsx:252`
- `core/src/plugin/native_trust.rs`

## Recommendation

Rewrite the Plugin trust warning: native plugins run out of process in an OS sandbox (one process per plugin, no file access outside its data folder, network only through termiHub). Reduced isolation needs an explicit per-build acknowledgement. The sandbox raises the cost of an attack but does not stop kernel/OS escapes or phishing inside the plugin's own terminal. Link plugin-authoring.md#the-plugin-sandbox and mention the sandbox in the Plugin system bullet at line 124.

## Verification

Confirmed. README.md:152 still says native plugins 'run arbitrary code with your full user privileges' and that 'An untrusted native plugin can do anything your user account can.' README.md:124 mentions only the C ABI and signing, with no sandbox. Meanwhile docs/architecture.md ADR-19 (#4189) says native plugins load only inside the sandboxed plugin-runner, the plugin-runner crate exists, and PluginInstallDialog.tsx:252 reads 'Native code — runs sandboxed'. This is drift between the docs and the app. It errs on the cautious side, so the severity is low.
