---
id: PLG2-002
title: "The Settings row treats any recorded ack as trusted even when its hash no longer matches the library, so after a plugin update the row says 'trusted', offers no Trust & Load, and the plugin silently stays unloaded"
angle: plugin-extensibility
severity: medium
category: ux-bug
is_workaround: false
subsystem: "src/components/Settings/NativePluginRow.tsx"
evidence:
  - src/components/Settings/NativePluginRow.tsx:64
  - src/components/Settings/NativePluginRow.tsx:74
  - src-tauri/src/commands/plugin.rs:405
  - core/src/plugin/host.rs:924
  - core/src/plugin/host.rs:1069
status: fixed
resolution: "#4294 — trust state reports whether the ack is current; a stale ack shows as needs re-approval with a review action"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`isTrusted = ack !== undefined && (!legacyAbi || ack.unverifiedToolchainAccepted)` never compares `ack.librarySha256` with the installed library. When a plugin update replaces the library, the host refuses the load with `NativePluginNotTrusted`. That error is returned before `record_refusal`, so the plugin-sandbox region has no status row and `isolationBadge` returns undefined. The row shows 'trusted' with only a Revoke button; the Trust & Load action is hidden because it renders only when `!isTrusted`. The only recovery is the non-obvious Revoke, then Trust.

## Why it matters

Updating a native plugin is a normal flow: there is an update check (#3383/#3490), and every update changes the library hash. After an update the plugin disappears from the connection types while the UI says it is trusted and shows no error. The user has nothing visible to act on, and the hash-bound consent (correctly fail-closed in the backend) looks to them like a broken plugin.

## Recommendation

Expose whether the ack is current. Either have `get_native_plugin_trust` (or `InstalledPlugin`) report `ackCurrent: library_sha256 == native_library_hash(id)`, or record `NativePluginNotTrusted` as a sandbox outcome ('Updated — trust the new build'). Compute `isTrusted` from that flag so a stale ack shows Trust & Load with 'The plugin changed since you trusted it'. Add a component test with a stale-hash ack.

## Verification

Confirmed. NativePluginGateSettings passes acknowledgments.get(id) raw. NativePluginRow.tsx:64 sets isTrusted = ack !== undefined && (...) and never compares librarySha256. Trust & Load renders only when !isTrusted. host.rs:925 returns NativePluginNotTrusted before the start_runner path that calls record_refusal (line 960), so no sandbox status is recorded. After a normal update (new library hash) the row shows trusted with only Revoke, and the plugin silently stays unloaded.
