---
id: PLG-007
title: Plugin connectionType id is load-order-dependent (disambiguation) — breaks saved connections
angle: plugin-extensibility
severity: medium
category: reliability
is_workaround: true
subsystem: core/src/plugin/host.rs
evidence:
  - core/src/plugin/host.rs:357
  - core/src/plugin/host.rs:521
status: open
---

## What
When a plugin registers its `connectionType`, `disambiguate_type_id`
(`host.rs:357`) gives the plain name to the **first registrant** and suffixes any
later collider with `-<plugin_id>` (then `-<n>`). So the registry id a plugin's
backend gets is not the id it *declared* — it depends on what else is already loaded
at the moment it loads (another plugin claiming the same `connectionType`, or a
built-in with that name, or plain load order).

## Why it matters
A saved connection persists a **connection-type id**. If the id a plugin ends up
registered under can change between runs, saved connections silently stop
resolving:
- Plugin A and Plugin B both declare `connectionType: "k8s"`. Whichever loads first
  gets `"k8s"`; the other gets `"k8s-<id>"`. Load order is not pinned (it comes from
  a directory scan / enable order), so the *same* plugin can get `"k8s"` on one
  launch and `"k8s-b"` on another. Connections saved under the previous id no longer
  match any registered type.
- A future built-in that adds a `"k8s"` type would demote an already-installed
  plugin to a suffixed id, orphaning every connection the user saved against it.

The code comments call this "concept Edge Cases" handling, but first-registrant-wins
+ positional suffixing is a **workaround** for the absence of a stable namespace, and
it trades a name collision for silent data-reference breakage — the worse failure.

## Evidence
- `core/src/plugin/host.rs:357-377` — `disambiguate_type_id`: plain id to the first,
  `-{plugin_id}` / `-{n}` to colliders.
- `core/src/plugin/host.rs:521-531` — the resolved id (possibly suffixed) becomes the
  registered `type_id` and the connection's persisted type.
- The security expert separately flagged the *TOCTOU* on `has_type` here; this entry
  is the *persistence-stability* consequence.

## Recommendation
Give plugin-provided types a **stable, collision-free namespace that does not depend
on load order** — e.g. always register as `plugin:<plugin_id>:<connectionType>`
(never the bare name), so a given plugin's type id is a pure function of its own
manifest and can never be stolen or demoted by another plugin or a built-in. Persist
and resolve saved connections against that namespaced id. This removes both the
TOCTOU and the load-order instability, and lets `displayName` carry the friendly
label without the id ever changing.
