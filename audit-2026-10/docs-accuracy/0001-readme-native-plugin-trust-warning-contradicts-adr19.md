---
id: DOC2-001
title: "README plugin trust warning says native plugins run in-process with full user privileges, contradicting ADR-19 / SECURITY.md sandbox"
angle: docs-accuracy
severity: medium
category: contradiction
is_workaround: false
subsystem: "README / plugins"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - README.md:124
  - README.md:152
  - SECURITY.md:90-118
  - docs/architecture.md:3456
  - core/src/plugin/sandbox/mod.rs:52-53
  - core/src/plugin/host.rs:949
  - core/src/plugin/native_trust.rs:168-172
---

## What

README line 124 says native backends are "loaded over a C ABI". The warning at line 152 says native plugins "run arbitrary code with your full user privileges" and "An untrusted native plugin can do anything your user account can". Since ADR-19 (#4189, 2026-10-08), native plugins never load into the termiHub process. Each one runs in a termihub-plugin-runner process confined by an OS sandbox (landlock/seccomp/namespaces, Seatbelt, LPAC AppContainer + job object), with no in-process fallback and no switch to turn the sandbox off (sandbox/mod.rs:52, host.rs:949). They are also off globally by default (native_trust.rs:168). SECURITY.md:90-118 describes this correctly. The README is the landing doc and now contradicts both SECURITY.md and the architecture ADR, and it never says that native plugins are off by default.

## Why it matters

Security docs that contradict each other are a defect on a safety-critical release. A user or evaluator gets two different threat models depending on which document they read. Reporters may also be confused about what counts as a sandbox escape, which SECURITY.md lists as a vulnerability class.

## Recommendation

Rewrite README.md:124 and :152 to match ADR-19. Say that native plugins are off by default, need a per-plugin trust acknowledgement, and run out of process in an OS sandbox that limits files, network, processes and devices, with network and file access only through the permission-checked bridge. Keep the advice to install only trusted plugins: the sandbox limits what a plugin can reach, not what it draws in its own terminal, and it does not protect against kernel bugs. Link to SECURITY.md#native-plugin-sandbox. Also mention the opt-in periodic plugin update check (Settings → Plugins → Check for Plugin Updates Automatically, off by default) in the "What phones home" note at README.md:89.

## Verification

Confirmed. README.md:124 says native backends are 'loaded over a C ABI', and the warning at :152 says they 'run arbitrary code with your full user privileges'. core/src/plugin/sandbox/mod.rs:50-55 says the sandboxed runner is 'the only model' since #4189, with no in-process load path and no way to turn it off. The README warns of more risk than actually exists, which is the safer direction to be wrong in, but it contradicts ADR-19 and SECURITY.md.
