# Frontend state layer — audit summary

Angle owner: frontend state-management expert. Scope: `src/store/**` (appStore + slices +
bridges), `src/hooks/**`, `src/services/transport/**`, and the projection-mirror glue between
backend regions and the Zustand store. Read-only.

## The state architecture as-built

**Two substrates coexist, mid-migration:**

1. **The god store** — `src/store/appStore.ts`, one 8,156-line Zustand `create<AppStore>`
   (~361 fields / ~224 actions per other angles). Still owns the layout engine, ~15+ per-tab
   `Record<tabId,…>` maps, persistent sessions, tunnels, macros, plugins, multi-window and restore
   orchestration, plus module-level id counters.

2. **The projection substrate** (#2149+) — the backend is the single authoritative writer for a
   growing set of **regions**; each region is driven into the frontend by a `ProjectionClient`
   (`src/services/transport/ProjectionClient.ts`) that adopts a snapshot, applies ordered RFC-6902
   diffs, gap-detects (`baseVersion !== version → resync`), and — since #2533 — carries a
   **version-gated optimistic overlay** (`dispatchOptimistic` + rollback-on-reject). A per-domain
   **bridge** (`*Bridge.ts`) fans one region out to `useProjected*` hooks.

**Inversion status: 10 of 11 bridges are region-as-sole-authority** — the local `appStore`
reducer/slice was deleted (connections #2401, agents #2409, settings #2404, transfers #2229,
monitors #2224, broadcast, workflow-run, restore-cohort, session-lifecycle #2283). Two optimistic
styles: **client overlay via `dispatchOptimistic`** (session, file-browser, layout) vs
**fire-and-forget intent + server-side fold** (connections, agents, settings, transfers, monitors,
broadcast, workflow-run, restore-cohort). **layout is the outlier**: region-authoritative-via-mirror
after #2562, but the hot-path reducer removal is deferred and its module docs are stale.

**The selector/subscription layer is genuinely good.** A full sweep of 484 non-test `useAppStore`
call sites plus every `useProjected*` hook found **no** object/array-literal selectors, **no**
whole-store subscriptions, and no need for `useShallow` — the store instead uses small atomic
primitive selectors, a WeakMap-memoized `getComposedLayout`, and shared empty-array constants. The
god store is a *maintainability* problem, not a re-render problem. The one ref-stability slip is
`useProjectedSessionLifecycle` (FES-010).

## Systemic risks

- **Optimistic-vs-authoritative is not atomic on the fire-and-forget bridges.** Connection
  mutations dispatch a region intent AND a separate disk-persist with no coupling and no rollback;
  partial failure diverges the UI from disk and resurrects/vanishes entities on reload (FES-005).
- **Id generation is unsafe.** Bare `Date.now()` connection/folder ids collide and overwrite
  (FES-001); per-window monotonic `tab-N` ids collide across desktop windows while being used as
  shared-region keys (FES-004). Several other id helpers lean on `Date.now()+random(4)`.
- **Integrity is enforced by convention, not construction.** Per-tab state is ~15 parallel maps
  hand-pruned at each close seam (FES-003); connection delete does no dependent-reference sweep
  (FES-009); stale-version guarding is present in only 3 of 11 bridges (FES-006). Each is one
  forgotten line away from a leak or a divergence.
- **Post-inversion residue.** Dead compose functions + stale docs in layoutBridge (FES-007) and
  sessionBridge (FES-008); a write-only dead `remoteStates` map still fed on every session event
  (FES-002). These must be deleted before release per the workaround mandate.

## Top issues ranked

| id | sev | title |
| --- | --- | --- |
| FES-005 | high | Connection mutations apply region-intent + disk-persist non-atomically, no rollback → UI/disk divergence, phantom resurrection |
| FES-001 | high | Bare `Date.now()` connection/folder ids collide and silently overwrite entities |
| FES-004 | medium | Per-window monotonic `tab-N` ids collide across windows, used as shared-region keys |
| FES-009 | medium | `deleteConnection` does no referential-integrity sweep (orphan persistentSessions/tunnels/tabs) |
| FES-003 | medium | Per-tab state scattered across ~15 hand-pruned parallel maps → drift/leak (e.g. `terminalForceFreshReconnect`) |
| FES-002 | medium | `remoteStates` write-only dead state, fed every session event, read by nothing (workaround) |
| FES-006 | medium | Inconsistent stale-version guarding across bridges; single-client invariant unenforced |
| FES-007 | medium | layoutBridge dead compose fns + stale flag/@link/instant-revert docs (workaround) |
| FES-011 | medium | appStore.ts is an 8,150-line god module / serialization point |
| FES-008 | low | sessionBridge docs + logs describe a deleted local fallback (workaround) |
| FES-010 | low | `useProjectedSessionLifecycle` returns an unmemoized fresh object each render (perf) |

## Notes for other angles
- FES-004 compounds **state-machine-ux SM-003** (session region keyed by tab id): the key is not
  only semantically wrong for multi-desktop, it isn't even unique across this app's own windows.
- The clean selector layer contradicts any assumption that the god store causes re-render storms —
  the perf cost is CPU-in-selectors at worst, not subscription fan-out.
