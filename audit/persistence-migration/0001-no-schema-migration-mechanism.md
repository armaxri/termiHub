---
id: PER-001
title: No schema-version migration mechanism for any persisted store
angle: persistence-migration
severity: critical
category: arch
is_workaround: false
subsystem: src-tauri/src (all storage.rs), agent/src/state
evidence:
  - src-tauri/src/connection/config.rs:145
  - src-tauri/src/workspace/config.rs:162
  - src-tauri/src/session_history/config.rs:45
  - src-tauri/src/workflows/config.rs:132
  - src-tauri/src/connection/settings.rs:125
  - agent/src/state/persistence.rs:13
status: in-progress
resolution: "#2746 — framework + 6 stores; rest #2744/#2745"
---

## What

Every persisted store except the encrypted credential envelope carries a `version` string field —
`ConnectionStore.version = "2"`, `WorkspaceStore.version`, `SessionHistoryStore.version`,
`WorkflowStore.version`, `AppSettings.version`, `LastSession.version`, all `"1"` — but **that field
is never read, compared, or branched on anywhere in the codebase.** There is no `migrate()` step, no
version dispatch, no upgrade/downgrade handling. A repository-wide search for schema migration turns
up only *credential-id* renaming, *portable-config-dir* relocation, and the agent's one-off legacy
`sessions.json` path migration — none of which is a data-schema version migration.

Forward/backward compatibility therefore rests entirely on two implicit serde behaviours:

1. `#[serde(default)]` on newly-added optional fields (a new app reading old data fills the gap), and
2. connection *settings* being stored as an opaque `serde_json::Value` that round-trips verbatim.

That covers **purely additive, optional** schema changes. It does not cover field renames, type
changes, structural moves, or newly-required fields, and it has **no downgrade path** at all.

## Why it matters

termiHub **auto-updates**. The moment any persisted schema changes in a way that is not a pure
optional-field addition, one of these happens with zero migration code to catch it:

- **New app, old data:** a renamed/moved/retyped field deserializes to its default (silent data
  loss of that field) or fails the whole parse → the store's recovery path treats the file as
  *corrupt* and **resets it to defaults** (see PER-004), wiping the user's real data.
- **Old app, new data (rollback / staged auto-update revert):** the older binary cannot parse the
  newer file, again hitting the "corrupt → reset to defaults" path and **wiping the file to
  `.bak`**; or, for typed structs, it silently **drops** every field the newer version added on the
  next save (PER-010).

The `version` fields give a false sense of safety: they look like a migration hook but nothing reads
them, so a developer bumping the schema has no framework to plug a migration into and no test that
would fail. On a ventilator-grade, auto-updating release this is the highest-impact data-safety gap.

## Evidence

- Version fields are declared with comments promising forward-compat migrations that do not exist,
  e.g. `session_history/config.rs:45` *"Schema version, for forward-compatible migrations"* and
  `workflows/config.rs:131` — but no consumer reads `.version`.
- `connection/storage.rs:144-148` hard-codes the recovered store to `version: "2"` and never checks
  the loaded version; parse failure jumps straight to reset/granular-recovery, not migration.
- The **only** store that inspects its version is the credential envelope
  (`credential/crypto.rs:217`, `master_password.rs:143`) — and it merely *rejects* a mismatch with
  no migration (PER-008), which is the failure mode this finding predicts.

## Recommendation

Introduce a real migration layer before the first auto-updating release:

1. Make `version` an integer (or semver) that every store **reads first**, before attempting a
   typed parse.
2. Add a per-store `migrate(value: serde_json::Value, from: u32) -> Result<CurrentSchema>` dispatch
   that transforms older on-disk shapes forward one version at a time. Run it inside
   `load_with_recovery` *before* the "corrupt → reset" fallback, so an unrecognized-but-newer schema
   is distinguished from genuine corruption.
3. Define an explicit **downgrade policy**: either refuse to load a newer `version` and surface a
   clear "this data was written by a newer version" message (never silently wipe), or preserve
   unknown content (see PER-010) so a rollback round-trip is lossless.
4. Add round-trip and cross-version fixtures (an old-schema file → new app → assert migrated) as
   regression tests, mirroring the existing `legacy_state_without_*` tests in
   `agent/src/state/persistence.rs`, which are the right pattern applied inconsistently.
</content>
