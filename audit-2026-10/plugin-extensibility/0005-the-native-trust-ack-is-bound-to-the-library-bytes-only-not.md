---
id: PLG2-005
title: "The native trust ack is bound to the library bytes only, not to the access the user approved, and survives uninstall, so a reinstall that widens the manifest's permissions loads without new consent"
angle: plugin-extensibility
severity: low
category: security
is_workaround: false
subsystem: "core/src/plugin/native_trust.rs + manager install/uninstall"
evidence:
  - core/src/plugin/native_trust.rs:62
  - core/src/plugin/native_trust.rs:90
  - core/src/plugin/host.rs:918
  - src-tauri/src/commands/plugin.rs:475
  - core/src/plugin/manager.rs:672
  - core/src/plugin/manager.rs:684
status: fixed
resolution: "#4294 — ack stores the approved access and the load requires an exact match; uninstall revokes the ack"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`NativeAck` records only `library_sha256`, and `PluginHost::load` checks only `trust.is_acknowledged(&id, &library_sha256)`. The trust surface shows `NATIVE_TRUST_DISCLOSURE` ('A plugin can only use its own data folder and the access listed below'). The listed access comes from the manifest's `permissions`, `filesystemPaths` and `connectionPolicy`, and none of that is part of the ack. Neither `PluginManager::install_with` nor `uninstall` touches `native-plugin-trust.json`; uninstall removes the plugin dir, data dir, state and settings but leaves the ack in place. Installing or updating a package with the same id and the same library bytes but a wider manifest (adding `network`, or `filesystemPaths:["/"]`) therefore loads silently under the old consent. The same happens after an uninstall and reinstall.

## Why it matters

The sandbox's security now rests on the bridge grants that the user approves through this ack. A malicious or compromised publisher can ship a benign-looking v1, get the user to click Trust & Load, then ship an 'update' that changes only manifest.json to grant itself network or whole-disk access. That update loads without ever showing the Trust & Load surface again, so the consent recorded by the ack no longer matches the access the plugin actually has.

## Recommendation

Bind the ack to the granted access as well. Store a canonical digest of (`permissions`, normalised `filesystemPaths`, `connectionPolicy`) in `NativeAck` next to `library_sha256`, and require both to match in `PluginHost::load`. A stored manifest digest that is missing or differs refuses the load as NativePluginNotTrusted, which re-shows the trust surface. Also revoke the plugin's ack in `PluginManager::uninstall`. Add a test: ack, reinstall with the same library plus `network`, and expect the load to be refused.

## Verification

Confirmed: NativeAck holds only library_sha256 (native_trust.rs), host.rs:924 checks only the hash, and PluginManager::uninstall (manager.rs ~669-699) removes the plugin dir, data dir, state and settings but never touches native-plugin-trust.json. So a widened manifest with identical library bytes loads under the old ack. Mitigation the finding leaves out: every install, update or reinstall goes through PluginInstallDialog, which shows the Requested Permissions list. Updates must use the same dialog, never silent (PluginUpdateSection.tsx:40-47). So adding `network` does get shown to the user at a second consent gate. What remains is narrower: filesystemPaths and connectionPolicy are not shown in the install dialog (only in the Settings sandbox chips), and a stale ack survives uninstall. Real defense-in-depth gap, low.
