---
id: FES-001
title: Connection and folder ids generated from bare Date.now() collide and silently overwrite entities
angle: frontend-state
severity: high
category: bug
is_workaround: false
subsystem: src/hooks/useConnections
evidence:
  - src/hooks/useConnections.ts:20
  - src/hooks/useConnections.ts:28
  - src/store/appStore.ts:5447
status: fixed
resolution: "#2724"
---

## What
`useConnections` mints new entity ids from a **bare millisecond timestamp with no
randomness**:

```ts
addConnection({ ...connection, id: `conn-${Date.now()}` });        // :20
const folder = { id: `folder-${Date.now()}`, ... };                // :28
```

Two connections (or two folders) created within the same millisecond receive the
**identical id**. Because the connections region and the store index entities by id,
the second insert does not create a second entity — it **overwrites** the first (or, on
the projection side, folds a duplicate key), so one of the two entities silently
vanishes.

## Why it matters
This is a data-loss path on a core inventory. It is not purely theoretical:

- **Bulk / programmatic creation** — SSH-config import, "duplicate", fleet onboarding,
  or any loop that calls `createConnection`/`createFolder` more than once per tick will
  reliably collide (a tight loop executes many iterations inside one millisecond).
- **Fast user input** — creating a folder and immediately a connection, or double-fire
  from a re-rendered handler, can land in the same tick.

The collided entity is lost with no error surfaced to the user. Downstream, any tab,
tunnel, or workspace reference to the overwritten id now points at the survivor's data.

The sibling path in `appStore.duplicateConnection` (`appStore.ts:5447`) and the group /
workspace id helpers use `Date.now()` **plus** a 4-char `Math.random()` suffix, which
merely lowers — does not eliminate — the same collision class (a 4-char base36 suffix is
~1.6M values; birthday collisions appear in bulk operations).

## Evidence
- `src/hooks/useConnections.ts:20` — `id: \`conn-${Date.now()}\`` (no randomness).
- `src/hooks/useConnections.ts:28` — `id: \`folder-${Date.now()}\`` (no randomness).
- `src/store/appStore.ts:5447` — `id: \`conn-${Date.now()}-${Math.random()...slice(2,6)}\``
  (randomised but still timestamp-anchored; weaker than a real unique id).

## Recommendation
Generate ids with `crypto.randomUUID()` (already used for workflow ids at
`appStore.ts:1706-1712` with a documented fallback) via a single shared `newEntityId(prefix)`
helper, and route **all** entity-id creation through it — connections, folders, groups,
workspaces, duplicates. Never derive an id from `Date.now()` alone. Add a store/region
invariant check that rejects an insert whose id already exists (surface a real error
instead of silently overwriting), and a regression test that creates two entities in the
same tick and asserts both survive.
