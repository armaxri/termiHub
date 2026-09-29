# Persistence, schema & migration audit

**Angle:** persistence-migration · **ID prefix:** `PER` · **Mode:** read-only

**Scope:** every on-disk store termiHub persists — saved connections/folders/agents, workspaces +
last-session layout, session history, macros/workflows, app settings, embedded-servers / WoL /
HTTP-monitor stores, the encrypted credential store, and the remote agent's `state.json`. Plus the
serde schema of the persisted structs, the atomic-write helper, corruption recovery, and
forward/backward-compatibility on version upgrade & rollback (the app auto-updates).

**Findings:** 10 (1 critical · 4 high · 4 medium · 1 low)

## The headline

**There is no schema-migration mechanism anywhere in the codebase.** Every persisted store except
the credential envelope carries a `version` string field — `"1"` / `"2"` — that is **written but
never read or branched on**. No store has a `migrate(from, to)` step, a version dispatch, or a
version gate. Forward/back-compatibility rests entirely on two implicit serde behaviours:

1. `#[serde(default)]` on newly-added optional fields (so a new app reading old data fills gaps), and
2. connection *settings* being stored as an opaque `serde_json::Value` (so unknown per-type keys
   round-trip verbatim).

That covers **purely additive, optional** schema changes and nothing else. It does **not** cover
field renames, type changes, structural moves, or newly-*required* fields — and, critically, it has
**no downgrade story**. For an auto-updating app this is the single biggest data-safety risk
(PER-001), and several other findings are amplifiers of it: unparseable = "corrupt" = **reset to
defaults / silent total wipe** (PER-004); typed structs silently **drop unknown fields** on a
load→save round-trip, so a rollback erases everything the newer version wrote (PER-010).

## Persisted-stores inventory

| Store | File | Format | Versioned? | Atomic write? | Concurrency-safe? | Migration path? |
| --- | --- | --- | --- | --- | --- | --- |
| Connections/folders/agents | `connections.json` | JSON tree (`"2"`) | field, unused | **yes** (`write_atomic`) | in-proc reload-merge; **no cross-proc lock** | none (granular recovery only) |
| Workspaces | `workspaces.json` | JSON (`"1"`) | field, unused | **yes** | **no lock** | none |
| Last session (layout) | `last-session.json` | JSON (`"1"`) | field, unused | **yes** | **no lock** | none |
| Session history | `session-history.json` | JSON (`"1"`) | field, unused | **NO — `fs::write`** | **no lock** | none |
| Macros / workflows | `workflows.json` | JSON (`"1"`) | field, unused | **NO — `fs::write`** | **no lock** | none |
| App settings | `settings.json` | JSON (`"1"`) | field, unused | **yes** | **no lock** | none |
| Embedded servers | `embedded-servers.json` | JSON (`"1"`) | field, unused | yes | no lock | none |
| WoL devices | JSON | JSON | (file wrapper) | yes | no lock | none |
| HTTP monitors | JSON | JSON | (file wrapper) | yes | no lock | none |
| Credential store | envelope file | **AEAD-encrypted** | **`u32=1`, version-CHECKED** | yes | in-proc `RwLock`; no cross-proc | **rejects** any other version (no up/down migration) |
| Agent state | `state.json` | JSON | **NO version field** | yes | **no lock** (multi-worker/daemon) | serde-default additive only |
| Agent definitions | `sessions.json` | JSON | — | yes | tokio `Mutex` in-proc | legacy `sessions.json` → new path migration exists |

## Top data-safety risks (ranked)

1. **PER-001 (CRITICAL)** — No schema-migration mechanism. `version` fields are dead metadata; an
   auto-update that changes any schema non-additively, or any rollback, silently mis-parses or
   wipes user data. The credential envelope is the *only* store that even checks its version — and
   it fails closed with no migration (PER-008).
2. **PER-004 (HIGH)** — "Corrupt = reset to defaults." Workspaces and session-history back up to
   `.bak` then **discard every record**. Because a newer-schema file is *indistinguishable from
   corrupt* to an older app, a downgrade silently wipes the live file to `.bak`.
3. **PER-005 (HIGH)** — No cross-process file locking on any JSON store. Two app instances (a
   second launch, or portable + installed sharing a config dir) load-then-save last-writer-wins and
   clobber connections / workspaces / last-session / settings.
4. **PER-006 (HIGH)** — The agent's `state.json` is shared across daemon/registry-daemon/client
   workers with **no lock** and **no version field**; a corrupt read silently returns an empty
   state, discarding *all* recoverable sessions.
5. **PER-003 (HIGH)** — `workflows.json` (user-authored macros/workflows) is written with
   non-atomic `fs::write`; a torn write on crash/power-loss leaves invalid JSON that the recovery
   path resets to defaults — total loss of user-created automation. `session-history.json`
   (PER-002) shares the exact defect.

## Upgrade-safety verdict

**Not upgrade-safe for anything beyond additive, optional schema changes; not downgrade-safe at
all.** The write-durability layer is in good shape for most stores (a well-designed `write_atomic`
helper with `sync_all` + temp-rename, plus per-store `.bak` corruption backups and #2318/#2320/#2366
regression tests) — but **two stores still bypass it** (PER-002, PER-003), there is **no
cross-process concurrency guard anywhere** (PER-005, PER-006), and the **migration/versioning story
is absent** (PER-001) with recovery that **destroys** rather than preserves on version mismatch
(PER-004, PER-010). Before an auto-updating release, the migration framework (PER-001) and the
downgrade-preservation behaviour (PER-004/PER-010) are the must-fix items; PER-002/003/005/006 are
concrete data-loss bugs with narrow, well-understood fixes.

## Finding index

- PER-001 (critical) — No schema-version migration mechanism for any persisted store
- PER-002 (medium) — `session-history.json` written non-atomically (torn-write total loss)
- PER-003 (high) — `workflows.json` (macros/workflows) written non-atomically (torn-write total loss)
- PER-004 (high) — Corrupt/unrecognized store resets to defaults; downgrade silently wipes to `.bak`
- PER-005 (high) — No cross-process locking; concurrent instances clobber every JSON store
- PER-006 (high) — Agent `state.json`: no lock, no version, corrupt read discards all sessions
- PER-007 (medium) — Stored passwords are shell/env-expanded, silently mangling secrets with `$`/`~`
- PER-008 (medium) — Credential envelope version-check has no up/down migration → rollback lockout
- PER-009 (low) — Dangling workspace→connection references silently preserved, never validated
- PER-010 (medium) — Typed structs drop unknown fields on round-trip → downgrade erases newer data
</content>
</invoke>
