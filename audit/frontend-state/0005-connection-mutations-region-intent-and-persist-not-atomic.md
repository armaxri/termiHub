---
id: FES-005
title: Connection mutations apply a region intent and a disk-persist as two independent calls with no rollback — partial failure diverges the UI from disk (phantom resurrection)
angle: frontend-state
severity: high
category: bug
is_workaround: false
subsystem: src/store/appStore + connectionsBridge
evidence:
  - src/store/appStore.ts:5364
  - src/store/appStore.ts:5442
  - src/store/connectionsBridge.ts:223
  - src/store/connectionsBridge.ts:142
status: open
---

## What
Every connection/folder mutation performs **two independent backend operations** with no
atomicity and no rollback between them:

1. `mirrorConnectionIntent("connection.remove"|"add"|"update", …)` — dispatches a granular
   intent to the authoritative `connections` **region**, which the backend applies and emits
   as a diff (the optimistic, immediately-visible transition).
2. A separate persist command — `removeConnection(...)` / `persistConnection(...)` /
   `apiMoveConnectionToFile(...)` — which writes the **on-disk** `connections.json`.

These are not coupled. `deleteConnection` (`appStore.ts:5364-5382`) fires the region intent,
then calls `removeConnection(...).catch(toast.error)`. The `mirror*` path uses plain
`transport().dispatch` (`connectionsBridge.ts:219-250`), **not** `dispatchOptimistic`, so it
has **no rollback** — if the intent lands server-side but the persist fails (or vice-versa),
nothing reverts the region.

## Why it matters
Interleaving on delete:
1. `connection.remove` intent applied → region drops the connection → sidebar shows it gone.
2. `removeConnection` rejects (disk error, permission, external-file read-only, race).
3. A `toast.error` fires, but **the region still shows the connection deleted**.
4. On next app start the region is re-seeded from disk (#2389/#2394 fold) → the connection
   **reappears** ("phantom resurrection"), silently contradicting what the user saw.

The add/duplicate paths have the mirror image: the region gains an entity the disk never
persisted, which vanishes on reload. The user is shown a success-shaped optimistic state that
the durable store never accepted, with only a transient toast as the signal. On a connection
inventory (which also anchors tunnels, tabs, workspaces), this is a data-consistency defect,
not cosmetic.

## Evidence
- `src/store/appStore.ts:5364-5382` — `deleteConnection`: `mirrorConnectionIntent` then
  `removeConnection(...).catch(...)`, no revert of the intent on persist failure.
- `src/store/appStore.ts:5442-5461` — `duplicateConnection`: same shape for add.
- `src/store/connectionsBridge.ts:223-250` — `mirrorConnectionIntent` /
  `dispatchConnectionIntent` uses `transport().dispatch` (fire-and-forget), not
  `dispatchOptimistic`; failures are swallowed via `logConnectionBridgeFallback`, no rollback.
- `src/store/connectionsBridge.ts:142-151` — the region fan-out overwrites `lastView` from
  each frame with no reconciliation against the persist outcome.

## Recommendation
Make the mutation atomic from the user's perspective: have the **persist command be the single
authoritative fold** that emits the region diff (so there is one backend write, not two), and
have the client dispatch its optimistic transition through `dispatchOptimistic` with a real
rollback fold (as sessionBridge/fileBrowsersBridge already do) so a rejected persist reverts
the region immediately instead of surfacing only a toast. Add a regression test that fails the
persist command and asserts the region reverts (the deleted connection reappears, the added one
disappears) rather than diverging until reload.
