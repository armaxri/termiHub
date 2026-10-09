---
id: PLG2-003
title: "plugin-authoring.md does not document filesystemPaths or connectionPolicy, and its own example manifest fails to load (filesystem permission with no paths)"
angle: plugin-extensibility
severity: medium
category: docs
is_workaround: false
subsystem: "docs/plugin-authoring.md"
evidence:
  - docs/plugin-authoring.md:76
  - docs/plugin-authoring.md:99
  - docs/plugin-authoring.md:113
  - docs/plugin-authoring.md:126
  - docs/plugin-authoring.md:529
  - core/src/plugin/security.rs:171
  - core/src/plugin/host.rs:877
  - core/src/plugin/manifest.rs:313
  - core/src/plugin/manifest.rs:321
status: fixed
resolution: "#4324 — documented connectionPolicy (and that ~ / env vars are not expanded in filesystemPaths) in plugin-authoring.md; the example manifest declares filesystemPaths and connectionPolicy and a core test loads it through the real validator; placeholders split to #4533, zero-timeout validation to #4534"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The canonical example manifest declares `"permissions": ["terminal", "network", "filesystem"]` with no `filesystemPaths`. `PermissionSet::check_consistency`, called from `PluginHost::load`, rejects exactly that combination with `FilesystemWithoutPaths`, so an author who copies the example gets a plugin that errors at load. The Fields table lists everything up to `updateUrl` but leaves out `filesystemPaths` and `connectionPolicy`. The sandbox section says `read_file` and friends need 'a path inside the declared roots' but never says where or how roots are declared, which forms are accepted (absolute only?), or that `~` and environment placeholders are NOT expanded. Without placeholders, a portable home-relative root such as `~/.kube` for the doc's own k8s-exec example cannot be expressed at all.

## Why it matters

Since ADR-19, direct std::fs access outside the data folder fails, so the bridge plus `filesystemPaths` is the only file-access mechanism a native plugin has. Authors cannot discover it from the authoring guide, the flagship example is broken, and the lack of portable roots pushes authors toward overly broad declarations such as `/` or `/home`. That is the opposite of least privilege, and it feeds the scope bug in the first finding.

## Recommendation

Add `filesystemPaths` (absolute roots, matched after symlink resolution, requires `filesystem`) and `connectionPolicy` (`maxConnections`, `connectTimeoutMs`, defaults 8 connections and the host timeout) to the Fields table. Fix the example manifest: add a `filesystemPaths` entry or drop `filesystem`. Either document that `~` is not expanded, or better, support a small fixed set of host-expanded placeholders (`${home}`, `${config}`) that are resolved at load and shown resolved in the access chips. Add a doc test that parses and consistency-checks the example manifest block.

## Verification

Confirmed. docs/plugin-authoring.md:76 example declares permissions [terminal, network, filesystem] and the doc contains no filesystemPaths or connectionPolicy anywhere (grep finds none). security.rs:171-173 returns FilesystemWithoutPaths for that combination, and host.rs:877 calls check_consistency at load, so the copied example fails to load. Line 530 mentions 'declared roots' without saying how to declare them. The placeholder/expansion part is a design suggestion, not verified as a defect.
