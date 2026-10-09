---
id: PER2-001
title: "Agent connections.json (definitions store) has no cross-process lock; concurrent --stdio/--listen workers lose each other's saved connections"
angle: persistence-migration
severity: medium
category: data-loss
is_workaround: false
subsystem: agent/src/session/definitions.rs
status: fixed
resolution: "#4285 — every connections.json mutation re-reads and saves under an exclusive std File::lock on the sidecar, so concurrent agent workers merge instead of overwriting"
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - agent/src/io/stdio.rs:35
  - agent/src/io/tcp.rs:49
  - agent/src/session/definitions.rs:349
  - agent/src/session/definitions.rs:400
  - agent/src/session/definitions.rs:943
  - agent/src/state/persistence.rs:449
---

## What

Each agent worker process builds its own `ConnectionStore::new(default_path())` (stdio.rs:35, tcp.rs:49). That loads the per-user connections.json into memory once (definitions.rs:349) and never reloads it. Every create/update/delete (e.g. definitions.rs:400) then writes the WHOLE in-memory snapshot through `save_to_disk` (definitions.rs:943), using an unlocked write_atomic. There is no FileLock, no re-read under a lock and no merge.

## Why it matters

This is the AGT-016 lost-update class, fixed for state.json with `AgentState::mutate_locked` (persistence.rs:449) but not for the agent's saved connections and folders. Under ADR-11 there is one --stdio process per desktop, and a reconnect can overlap an old worker. Two desktops on the same agent user, or an old and a new worker, each hold a stale snapshot. Desktop A creates connection X, then desktop B creates Y: B's save writes a file without X. X is gone permanently, with no error. B's list also never shows X. This is silent loss of connections the user created.

## Recommendation

Reuse the existing `crate::fs::FileLock` pattern. Wrap each mutating ConnectionStore operation in an acquire of the connections.json lock. Re-read the file under the lock (load_from_disk), apply the single delta (insert, update or remove one connection or folder), write atomically, release, and refresh the in-memory Definitions from the merged result. Add a two-store concurrent-create test like the state.json one at persistence.rs:1086.

## Verification

I confirmed the finding from the code; I lowered the severity from high to medium. stdio.rs:35 and tcp.rs:49 each build their own `ConnectionStore::new(default_path())`. `new()` loads connections.json once (definitions.rs:350) and nothing reloads it later: `load_from_disk` is called only from `new` and from a test. `create()` (definitions.rs:400-411) inserts into the in-memory `Definitions` and calls `save_to_disk`, which serializes the whole snapshot through `crate::fs::write_atomic` (definitions.rs:943 onward). That path has no lock and no merge. definitions.rs does not use `FileLock`; the only users are fs.rs and state/persistence.rs, which is the AGT-016 fix (#2801, `mutate_locked`). Two other guards exist, and neither prevents a lost update. `ensure_writable`/`guard_not_newer` only stop a newer-schema overwrite (#3920). `secure_pending_backup` only covers backup of a corrupt file (#3931). I found no single-instance guard that would stop two workers running at once. ADR-11 and its 11a amendment explicitly accept several concurrent workers per host user, so the setup the finding describes is a sanctioned one. I found no ADR or audit entry that accepts this lost update on purpose. The architecture.md text about multi-instance and connections.json file-watching is about the desktop's own connections.json, not the agent's store. The precondition is narrow: two workers for the same agent user must be alive at once (two desktops, or an old and a new worker overlapping) and both must mutate definitions. The loss is still silent and permanent for user-created connections. The sibling issue for state.json (AGT-016) was rated medium, so medium fits here too, not high.
