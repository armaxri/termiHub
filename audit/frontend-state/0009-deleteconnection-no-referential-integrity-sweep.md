---
id: FES-009
title: Deleting a connection performs no referential-integrity sweep — persistentSessions, tunnels and open tabs keep dangling connectionId references
angle: frontend-state
severity: medium
category: bug
is_workaround: false
subsystem: src/store/appStore
evidence:
  - src/store/appStore.ts:5364
  - src/store/appStore.ts:3537
status: open
---

## What
`deleteConnection` (`appStore.ts:5364-5382`) removes the entity from the `connections` region
and persists the deletion, but does **nothing** about the other state that references the
connection id. A whole-repo look at the action shows no touch of tabs, tunnels, or persistent
sessions. Several slices key off the connection id and are left dangling:

- `persistentSessions` is keyed by `connectionId` (`appStore.ts:3537,3559,3580,3592,3626`). A
  connection with a live persistent/background session keeps its `persistentSessions[connectionId]`
  entry after the connection is deleted — an orphan badge / reconnect target for a connection
  that no longer exists.
- Open tabs carry `connectionId` / `persistentConnectionId`; after delete these point at a
  removed entity.
- Tunnels reference an SSH connection by id; a tunnel whose SSH connection is deleted is now
  unresolvable.

## Why it matters
Referential integrity across slices is not maintained on the delete seam, so the store can hold
records that point at a non-existent connection. Concrete symptoms: a persistent-session badge or
"attached" indicator for a deleted connection; a tunnel that silently cannot resolve its SSH
target; a restored/handoff tab whose `connectionId` no longer resolves (compounding the restore
paths that already special-case "every referenced connection was deleted", `appStore.ts:7829-7844`).
None of these surface an error — they are quiet inconsistencies that accumulate over a session.

## Evidence
- `src/store/appStore.ts:5364-5382` — `deleteConnection`: region intent + persist only; no sweep
  of `persistentSessions` / tunnels / tabs (`bulkDeleteConnections` at `:5384` is the same).
- `src/store/appStore.ts:3537-3626` — `persistentSessions` is `connectionId`-keyed state that the
  delete never prunes.

## Recommendation
On connection delete (and bulk delete), sweep dependent state: drop or tombstone the
`persistentSessions[connectionId]` entry (tearing down any live session first), warn-or-orphan
tunnels that reference the SSH connection, and decide the contract for open tabs (keep working
from their config snapshot but clear the dangling `connectionId`, or prompt). Add a regression
test deleting a connection with an active persistent session + a dependent tunnel and asserting
no orphaned references remain. Ideally centralize dependents so the backend fold that owns the
connections region also emits the cascade, rather than the frontend reconstructing it.
