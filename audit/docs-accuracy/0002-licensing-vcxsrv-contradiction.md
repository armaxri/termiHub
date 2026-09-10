---
id: DOC-002
title: licensing.md contradicts code + THIRD_PARTY_LICENSES on VcXsrv redistribution; references a file/constant that no longer exist; counsel sign-off unchecked
angle: docs-accuracy
severity: high
category: docs
is_workaround: true
subsystem: docs/licensing
evidence:
  - docs/licensing.md:1
  - docs/licensing.md:50
  - docs/licensing.md:74
  - docs/licensing.md:79
  - THIRD_PARTY_LICENSES.md:55
  - src-tauri/src/terminal/xserver/windows.rs:1
  - src-tauri/src/terminal/xserver/types.rs:23
status: open
---

## What

`docs/licensing.md` still describes termiHub as **redistributing/hosting the VcXsrv binary** and
carrying GPL-3.0 distribution obligations for it. The code no longer does this: since #1318,
Windows VcXsrv is installed via `winget` and macOS XQuartz via Homebrew — nothing is hosted,
downloaded from a pinned URL, or checksum-verified. `THIRD_PARTY_LICENSES.md` was updated to
say exactly that, so licensing.md now contradicts both the code and its sibling attribution doc.
Two concrete file/constant references in the docs point at things that do not exist, and a
release-gating counsel sign-off is left unchecked while gating on a path that was removed.

## Why it matters

Licensing/compliance docs are release-critical and legally load-bearing. This doc:
(a) asserts a redistribution obligation the project no longer incurs (over-claiming a GPL burden),
(b) tells a releaser to verify a file that isn't in the tree,
(c) leaves a "must be confirmed by counsel before release" checkbox unticked while its stated
trigger ("ships or downloads any GPL/APSL artifact") no longer occurs. A reader cannot tell
whether the release is blocked, and the compliance checklist can never be completed as written.
Flagged `is_workaround` because it is a not-yet-cleared release gate that is now moot but still
sits in the tree.

## Evidence

- Prose over-claims redistribution: `docs/licensing.md:1` "how termiHub stays compliant when it
  **redistributes or hosts** third-party programs"; L50-55 "Because termiHub **redistributes the
  VcXsrv binary**, it must still satisfy GPL-3.0's distribution obligations for **that binary** …".
- Contradicted by the same file's own table `docs/licensing.md:62` (Windows: "**Installs via
  winget + runs** (does not host/redistribute)", "None for redistribution") and by
  `THIRD_PARTY_LICENSES.md:42-50` ("termiHub no longer redistributes or hosts a VcXsrv binary …
  obtained via winget").
- Dangling references: `docs/licensing.md:74` and `THIRD_PARTY_LICENSES.md:55` require the pinned
  version to match `PINNED_VCXSRV.version` in `src-tauri/src/terminal/xserver/acquire.rs`. That
  file and constant **do not exist** (grep for `PINNED_VCXSRV` returns nothing). Acquisition lives
  in `src-tauri/src/terminal/xserver/windows.rs` (winget) and `macos.rs` (brew); the only pin is
  the winget package id `marha.VcXsrv` — no version, URL, or SHA-256. See
  `src-tauri/src/terminal/xserver/types.rs:23` (`WINGET_INSTALL_VCXSRV_COMMAND`).
- Unchecked counsel gate: `docs/licensing.md:11-16` "treat the VcXsrv download path as
  not-yet-cleared for release"; checklist `docs/licensing.md:79` `- [ ] **Counsel has confirmed**
  …` remains unchecked — but there is no download path to clear.

## Recommendation

Rewrite licensing.md to match the winget/Homebrew reality: termiHub invokes an external installer
and runs a separate process; it does not redistribute or host any X-server binary, so no GPL-3.0
redistribution obligation attaches to termiHub's distribution (attribution/pointer only). Replace
the `acquire.rs` / `PINNED_VCXSRV` references with the real module paths in both docs. Resolve the
counsel checklist item explicitly — either remove the gate (no artifact is shipped) or re-scope it
to the winget-install stance and record the decision — so no dangling "not-yet-cleared for release"
gate remains at release time.
