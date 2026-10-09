---
id: SEC2-002
title: "Native-plugin trust acknowledgment is bound only to the library hash, so an update can widen permissions without new consent"
angle: security
severity: medium
category: security
is_workaround: false
subsystem: "core/src/plugin/native_trust.rs, plugin update/install flow"
evidence:
  - core/src/plugin/native_trust.rs:90
  - core/src/plugin/native_trust.rs:183
  - core/src/plugin/host.rs:876
  - core/src/plugin/host.rs:924
  - core/src/plugin/version_change.rs:24
  - src/components/Plugins/PluginInstallDialog.tsx:298
  - src/components/Settings/nativePluginSandbox.ts:182
status: fixed
resolution: "#4294 — trust ack binds library hash plus approved permissions, filesystemPaths and connectionPolicy; any change re-asks (install-dialog diff: #4418)"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`NativeAck` records only `library_sha256`, and `is_acknowledged(id, library_sha256)` gates the load. The permissions, `filesystemPaths` and `connectionPolicy` that the trust disclosure calls "the access listed below" are read fresh from the on-disk manifest at every load (`PermissionSet::from_manifest`) and are not part of the acknowledgment. An upgrade (`VersionChangeKind::Upgrade` proceeds without extra confirmation) that ships the same backend library with a manifest adding `network` and/or `filesystem` + new `filesystemPaths` keeps the old acknowledgment and loads with the wider grant. The install dialog shows only the permission names (no diff, and never `filesystemPaths`), and the native trust chips, which do show paths, are not re-shown because the ack still matches.

## Why it matters

This enables a bait-and-switch. The library of v1.0 can already contain code that attempts bridge calls, which are denied until the manifest grants them. A user who trusted a narrowly-scoped plugin silently grants network and file access on a routine update. The hash binding protects the binary but not the capability grant the user actually agreed to.

## Evidence

- `core/src/plugin/native_trust.rs:90`
- `core/src/plugin/native_trust.rs:183`
- `core/src/plugin/host.rs:876`
- `core/src/plugin/host.rs:924`
- `core/src/plugin/version_change.rs:24`
- `src/components/Plugins/PluginInstallDialog.tsx:298`
- `src/components/Settings/nativePluginSandbox.ts:182`

## Recommendation

Bind the acknowledgment to a digest of the security-relevant manifest fields (sorted permissions, normalized filesystemPaths, connectionPolicy) as well as the library hash. Treat a mismatch like a changed binary: refuse the load and show the trust dialog again with a 'new access requested' diff. Also show filesystemPaths, and any change versus the installed manifest, in PluginInstallDialog on update.

## Verification

Confirmed. NativeAck stores only library_sha256 plus two acceptance flags (native_trust.rs:84-110), and is_acknowledged compares only the hash (line 183). host.rs:876 rebuilds PermissionSet from the on-disk manifest at every load, after the hash gate. No code revokes an ack on update; the only revoke is user-initiated. An upgrade that keeps the library bytes but widens permissions or filesystemPaths therefore loads with the wider grant and the trust disclosure is not shown again. The install dialog shows permission names, which partly mitigates this, but filesystemPaths are not shown and there is no diff.
