---
id: DOC-011
title: README omits two shipped, security-relevant subsystems — the on-launch GitHub update check and the native plugin system (no user-facing plugin trust warning)
angle: docs-accuracy
severity: high
category: docs
is_workaround: false
subsystem: README/user-docs
evidence:
  - README.md:64
  - src-tauri/src/commands/update.rs:11
  - src/App.tsx:264
  - core/src/plugin/host.rs:41
  - src-tauri/src/lib.rs:548
  - docs/plugin-authoring.md:189
status: fixed
resolution: "#2723"
---

## What

Two shipped, security-relevant subsystems are absent from the user-facing README:

1. **On-launch update check.** The app contacts the GitHub Releases API ~5 s after startup and
   every 24 h, and surfaces update / security-update notifications (including a non-suppressible
   red-dot for releases flagged with a `<!-- security -->` marker). The README's only mention of
   updates is "No auto-update — download new versions manually" (technically true: it notifies and
   opens the browser, it does not self-install), which omits that the app phones home on every
   launch. There is no privacy/telemetry note anywhere in the README.
2. **Native plugin system.** A full plugin system is shipped and enabled by default: users can
   install/enable plugins from a Plugins sidebar/Settings UI, including **native cdylib backends
   loaded over a C ABI via `libloading`** (arbitrary native code) with an Ed25519 signature/trust
   model. The README never mentions plugins at all — so there is no user-facing **plugin trust
   warning** about installing untrusted native plugins.

## Why it matters

For a safety-critical, security-conscious audience: (1) an app that makes an unmentioned network
call to GitHub on every launch is a documentation/consent gap — users evaluating it for isolated
environments need to know. (2) A shipped mechanism that loads arbitrary native code from installed
plugins, with zero mention in user docs, is a real security-communication gap; the trust model
(`Untrusted/Tampered/Signed/Verified`) exists in code but the user is never warned in the README to
install only trusted plugins. Release-critical missing user docs per the audit brief (security/
threat model for users; plugin trust warning).

## Evidence

- Update check is shipped, always-on: `src-tauri/src/commands/update.rs:11` (`GITHUB_API_URL` →
  `/repos/armaxri/termiHub/releases/latest`), `:135` sets `available`, `:137` reads the security
  marker; scheduled unconditionally at `src/App.tsx:264-265` (5 s + every 24 h), notification mounted
  `src/App.tsx:366`. README.md:64-67 mentions only "No auto-update"; no telemetry/privacy note.
  (Terminology nit: `docs/contributing.md:794` calls this "self-update" — it is notify-only.)
- Plugin system is shipped/enabled: host + manager created at `src-tauri/src/lib.rs:522-532` and
  `load_enabled_plugins()` at `lib.rs:548-568`; native ABI loading via `libloading` at
  `core/src/plugin/host.rs:41`; commands registered `lib.rs:1346-1358`; UI in
  `src/components/Plugins/` + Sidebar "Plugins" view. Trust model in `core/src/plugin/security.rs`.
  README has no "plugin" mention.
- `docs/plugin-authoring.md:189-248` documents the native ABI and even an "ABI caveat — read this",
  but that is a contributor doc; nothing user-facing warns about installing untrusted plugins.

## Recommendation

Add a short README section (or link) covering: (a) the update-check behavior and what data leaves
the machine (a GitHub API call), ideally with the setting to disable `auto_check`; and (b) the
plugin system, prominently including a trust warning that native plugins run arbitrary code and only
signed/trusted publishers should be installed. Fix the "self-update" misnomer in contributing.md.
