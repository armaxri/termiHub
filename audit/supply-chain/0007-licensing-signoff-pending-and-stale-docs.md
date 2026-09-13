---
id: SUP-007
title: X-server (GPL/APSL) licensing sign-off is unchecked for release, and licensing docs are internally stale
angle: supply-chain
severity: medium
category: docs
is_workaround: false
subsystem: docs/licensing
evidence:
  - docs/licensing.md:11
  - docs/licensing.md:50
  - THIRD_PARTY_LICENSES.md:42
  - src-tauri/Cargo.toml:167
status: open
---

## What

termiHub interacts with two copyleft/restrictive-licensed X servers (VcXsrv,
GPL-3.0; XQuartz, APSL-2.0/MIT) for X11 forwarding, and retains their license
texts under `licenses/GPL-3.0.txt` and `licenses/APSL-2.0.txt`. Two problems:

1. **Release sign-off is explicitly open.** `docs/licensing.md` states the
   arm's-length/aggregation stance "**must be confirmed by counsel before a
   release that ships or downloads any GPL/APSL artifact**" and "**Until that
   sign-off is recorded, treat the VcXsrv download path as not-yet-cleared for
   release.**" The compliance checklist item "**Counsel has confirmed** the
   arm's-length/aggregation stance … and the sign-off is recorded in the release
   PR" is unchecked. This is a live release-gating item.

2. **The licensing docs contradict the actual code.** The current code path is
   **winget-only** — `src-tauri/src/terminal/xserver/windows.rs` documents that
   "termiHub no longer hosts/redistributes a VcXsrv `.zip`, so the GPL-3.0
   redistribution burden of the old download path … is gone," and
   `THIRD_PARTY_LICENSES.md` agrees. But `docs/licensing.md` still asserts in
   prose "Because termiHub **redistributes** the VcXsrv binary, it must still
   satisfy GPL-3.0's distribution obligations" and describes "**Hosting** a pinned
   VcXsrv `.zip` next to termiHub's own release artifacts" as mere aggregation —
   a scenario the code no longer performs. The doc's own per-platform table
   correctly says "does not host/redistribute", so the document disagrees with
   itself.

Additionally, `src-tauri/Cargo.toml:167` still comments the Windows `zip`
dependency as "VcXsrv acquisition (X server provisioning): download + extract",
describing the retired path — a stale rationale that no longer matches the
winget-only implementation.

## Why it matters

For a distributed desktop app, GPL/APSL handling is a genuine
distribution-blocking concern. An internally-contradictory licensing document is
a liability: a reviewer or counsel reading it cannot tell whether the shipped
configuration redistributes a GPL binary (it does not, per the code) or hosts a
`.zip` (per the stale prose). The unchecked counsel sign-off means the licensing
posture is, by the project's own rule, not release-cleared.

## Evidence

- `docs/licensing.md:11-15` — counsel-confirmation caveat + "not-yet-cleared for
  release" instruction.
- `docs/licensing.md:50-56` — stale "termiHub redistributes the VcXsrv binary"
  prose; `docs/licensing.md:42` — "Hosting a pinned VcXsrv `.zip`" as aggregation.
- `docs/licensing.md:60-64` + `THIRD_PARTY_LICENSES.md:42-46` — the correct
  winget-only, no-redistribution statement (self-contradiction).
- `src-tauri/src/terminal/xserver/windows.rs:1-9` — code is winget-only, download
  path retired (#1318).
- `src-tauri/Cargo.toml:166-168` — stale "download + extract" comment on `zip`.

## Recommendation

Reconcile `docs/licensing.md` to the winget-only reality: delete the
"redistributes the VcXsrv binary" / "hosting a `.zip`" prose (or move it to a
clearly-labelled historical note), so the document uniformly reflects that
termiHub does not redistribute or host either X server. Refresh the stale `zip`
dependency comment. Then either (a) record the counsel sign-off in the release PR
per the checklist, or (b) since the code no longer conveys GPL/APSL binaries,
have counsel confirm the *reduced* obligation (attribution only) and check the
box. Do not release with the checklist item open.
