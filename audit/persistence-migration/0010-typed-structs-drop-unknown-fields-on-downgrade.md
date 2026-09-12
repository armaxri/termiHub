---
id: PER-010
title: Typed persisted structs drop unknown fields on round-trip — a downgrade erases newer data
angle: persistence-migration
severity: medium
category: reliability
is_workaround: false
subsystem: src-tauri/src/connection/settings, src-tauri/src/workspace, agent/src/state
evidence:
  - src-tauri/src/connection/settings.rs:122
  - src-tauri/src/workspace/config.rs:161
  - agent/src/state/persistence.rs:13
status: fixed
resolution: "#2746 — unknown-field round-trip"
---

## What

serde's default behaviour is to **ignore unknown fields on read and omit them on write** (only
`core/src/plugin/manifest.rs` uses `deny_unknown_fields`, and none of the persisted user-data structs
preserve unknowns). So when an **older** app loads a store written by a **newer** app, every field
the newer version added is dropped from the in-memory struct — and the next save writes the struct
back **without those fields**, permanently erasing them from disk.

`AppSettings` (`connection/settings.rs:122`), `WorkspaceStore`/`WorkspaceDefinition`
(`workspace/config.rs:161`), `LastSession`, `SessionHistoryStore`, `WorkflowStore`, and `AgentState`
are all fully-typed structs with this behaviour. The **one** place this is handled well is connection
*settings*, which are stored as an opaque `serde_json::Value` and explicitly documented to
round-trip unknown keys verbatim (`connection/config.rs:115` — "Unknown keys round-trip verbatim").
That good pattern is the exception, not the rule.

## Why it matters

This is the concrete downgrade-data-loss mechanism behind PER-001. On an auto-updating app a rollback
is not rare (staged-update revert, a user pinning an older build). Sequence: vN+1 adds
`AppSettings.newThing` and the user configures it; a downgrade to vN loads settings (silently
dropping `newThing`), the user changes any unrelated setting, vN saves — and `newThing` is now gone
from disk even after re-upgrading to vN+1. The loss is silent and irreversible. It compounds with
PER-004: whether a newer file is *dropped field-by-field* (typed structs) or *wiped wholesale*
(parse failure → reset) depends only on whether the newer change happened to still deserialize.

## Evidence

- `connection/settings.rs:119-122` — `AppSettings` derives `Serialize, Deserialize` with
  `#[serde(default, rename_all = "camelCase")]` and no unknown-field capture; unknowns are dropped.
- `workspace/config.rs:161-168`, `agent/src/state/persistence.rs:13-22` — same: typed structs, no
  `#[serde(flatten)]` catch-all, no `deny_unknown_fields`.
- `connection/config.rs:115` — the counter-example: opaque `Value` settings that preserve unknown
  keys.

## Recommendation

Decide the downgrade policy per store (see PER-001). To make round-trips lossless, add a
`#[serde(flatten)] extra: serde_json::Map<String, Value>` catch-all to the top-level persisted
structs so an older binary preserves and re-writes fields it does not understand — the same
verbatim-round-trip property the connection-settings `Value` already enjoys. Alternatively, gate on
`version` and refuse to write when the on-disk version is newer than the binary (never silently
overwrite newer data). Add a cross-version round-trip test: newer-shaped JSON → old struct → save →
assert the newer fields survive.
</content>
