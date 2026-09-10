---
id: PLG-003
title: Exact-match ABI gate + rapid pre-release churn → every auto-update orphans all native plugins
angle: plugin-extensibility
severity: high
category: arch
is_workaround: false
subsystem: plugin-api
evidence:
  - plugin-api/src/lib.rs:114
  - core/src/plugin/host.rs:284
  - plugin-api/src/lib.rs:122
status: open
---

## What
The native ABI compatibility gate is **exact** `u32` equality
(`host.rs:284`: `found != CURRENT_PLUGIN_API_VERSION`), and the ABI number is a
single monotonic counter bumped on *any* layout-affecting change. It has already
churned `1 → 2 → 3 → 4` before v0.1.0 ships (documented in `plugin-api/src/lib.rs:122-143`:
#2018 added the host bridge, #2024 grew the bridge vtable, #2030 grew
`PluginStatus`). There is no forward compatibility, no "additive-only" vtable
discipline, no major/minor split — a plugin built against ABI *N* loads on host
ABI *N* and nothing else.

Because termiHub auto-updates, this means: **every host update that touches the ABI
silently orphans every installed native plugin.** The updated host reports ABI 5,
the user's installed plugin was built against 4, and it stops loading with
`IncompatibleAbi` → `PluginState::Error`.

## Why it matters
- **The ecosystem cannot keep up with the host.** An auto-updating app on a rapidly
  churning exact-match ABI guarantees that third-party plugins break on a routine
  update the author had no warning about. The author must rebuild against the exact
  new ABI and redistribute *before* users update — impossible to coordinate against
  a silent background updater.
- **The graceful degradation path does not cover this case.** `reconcile_compatibility`
  (`manager.rs:518`) auto-disables incompatible plugins "with a notification" — but
  it keys on the **manifest** apiVersion (frozen at 1.0, see PLG-002), not the
  native ABI. So a native ABI skew never triggers the friendly auto-disable; it
  surfaces as a raw load error at startup instead.
- **Four breaking bumps pre-release with zero shipped plugins** shows the ABI is not
  yet stable enough to be a "stable contract." Freezing it is a precondition for an
  ecosystem, not a nice-to-have.

## Evidence
- `plugin-api/src/lib.rs:114-144` — the version doc-comment enumerates the 2→3→4
  breaking layout changes; `CURRENT_PLUGIN_API_VERSION: u32 = 4`.
- `core/src/plugin/host.rs:284-289` — exact-equality gate, `IncompatibleAbi` on any
  mismatch (higher *or* lower).
- `core/src/plugin/manager.rs:518-549` — the auto-disable-on-incompatibility path
  only inspects `manifest.api_compatibility()`, not the native ABI.

## Recommendation
1. **Split the ABI number into major.minor and make the gate `major ==` + `minor >=`
   additive**, so the host can load older-minor plugins by only ever *appending* to
   vtables/enums (never reordering/removing). The current `#[repr(C)]` design already
   supports append-only growth; the gate just needs to allow it.
2. **Freeze the ABI before release.** Land all planned bridge/status growth, then
   commit to append-only. Four pre-release breaking bumps means the contract is not
   ready to be promised.
3. **Route native ABI skew through the same graceful auto-disable + notification** as
   manifest incompatibility, so an orphaned plugin after an update tells the user
   "disabled, needs an update" rather than erroring silently.
4. Until (1)-(3), gate native plugin loading behind an explicit experimental opt-in
   (as the frontend plugins already are — see PLG-006), so users are not surprised by
   plugins that die on every update.
