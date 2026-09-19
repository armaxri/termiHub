---
id: PLG-012
title: No plugin update/version semantics and no discovery/registry — install is blind local-file replace
angle: plugin-extensibility
severity: medium
category: missing-feature
is_workaround: false
subsystem: core/src/plugin/manager.rs
evidence:
  - core/src/plugin/manager.rs:372
  - core/src/plugin/manifest.rs:225
status: open
---

## What
Installing a plugin is a blind by-id replace: `install()` extracts into
`plugins/<id>/`, "replacing any prior install of the same id," with **no version
comparison** — the manifest `version` is explicitly "informational; the host does
not interpret it." There is:
- no upgrade/downgrade detection or protection (installing an older `version` over a
  newer one just succeeds),
- no update notification / "a newer version is available",
- no changelog or migration hook between versions,
- no discovery or registry — plugins arrive only as local `.termihub-plugin` files
  the user must find and side-load.

## Why it matters
For a plugin *ecosystem*, updates and discovery are core, not polish. Today a user
has no way to learn a plugin exists, no way to be told one has an update, and no
protection against silently clobbering a working plugin with a broken/older build.
Combined with the ABI-churn orphaning (PLG-003), the update story is exactly where
users will feel pain — a host auto-update breaks their native plugins and there is
no mechanism to pull a rebuilt version.

## Evidence
- `core/src/plugin/manager.rs:372-465` — `install()`: trust gate → extract → mark
  enabled; no version check, replaces by id.
- `core/src/plugin/manifest.rs:225` — "Plugin version string (informational; the
  host does not interpret it)."

## Recommendation
For v0.1 this is acceptable *if scoped and documented* as "manual, local install
only; no auto-update or registry." But add at least: compare `version` on install
and warn on downgrade; expose "installed version" in the management UI (it stores the
manifest, so this is cheap). A registry/discovery and update-check mechanism are the
larger ecosystem features to plan explicitly rather than leave as an implied gap.
