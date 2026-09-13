---
id: PLG-010
title: plugin-authoring.md status banner and version guidance are stale/incomplete
angle: plugin-extensibility
severity: medium
category: docs
is_workaround: false
subsystem: docs/plugin-authoring.md
evidence:
  - docs/plugin-authoring.md:8
  - docs/plugin-authoring.md:186
  - docs/plugin-authoring.md:99
status: open
---

## What
The authoring guide is out of step with the shipped code in several places:

1. **Status banner understates what exists.** `docs/plugin-authoring.md:8-12` says
   the runtime host/loader and management UI "are tracked separately and may not be
   present in every build." In fact `PluginHost`, the loader, the `plugin://`
   protocol, `HostLifecycleHook`, the Tauri command surface, and a
   `PluginSettingsSection` management UI are all wired into `src-tauri/src/lib.rs:522`.
   The doc reads as if the system might not run; it does.

2. **protocolParser/statusBarWidget "wiring is host/loader work"** (`:186`) is stale:
   they *are* wired through the sandbox (frontendPlugins.ts) — but only behind the
   default-off gate (see PLG-009). The doc neither says they run nor that they are
   gated.

3. **Version guidance is wrong/confusing.** Every example uses `"apiVersion": "1.0"`
   (`:99`, `:66`) while the native ABI the author actually compiles against is
   version `4` (PLG-002). The doc never tells the author these are different numbers,
   never says which ABI their crate revision targets, and never gives an obtainable
   dependency line (PLG-001).

4. **No operational toolchain guidance.** The ABI caveat says a plugin must be built
   with "a compatible Rust toolchain" (`:232`) but never says *which* — there is no
   recorded/enforced toolchain version (PLG-013), so this is unactionable.

## Why it matters
The doc is billed as "the authoring contract; it stays accurate regardless of loader
progress." An author following it today gets a wrong mental model of what's shipped,
writes a version number that doesn't govern loading, and has no supported way to
obtain the SDK. For a pre-release audit these are the first things a prospective
plugin author hits.

## Evidence
- `docs/plugin-authoring.md:8-12` — stale status banner vs `src-tauri/src/lib.rs:522`.
- `docs/plugin-authoring.md:186-188` — "wiring … is host/loader work".
- `docs/plugin-authoring.md:99`, `:66` — `apiVersion "1.0"` throughout.
- `docs/plugin-authoring.md:224-247` — ABI caveat with no concrete toolchain/version.

## Recommendation
Refresh the guide: correct the status banner to reflect the shipped host/loader/UI;
mark the JS extension points as experimental/gated; add a single authoritative
version story (one number, set by the packer — PLG-002) plus an obtainable
dependency line (PLG-001); and state the required/tested Rust toolchain explicitly
once PLG-013 records it.
