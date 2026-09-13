---
id: FES-006
title: Stale-version guarding is inconsistent across projection bridges; the "one ProjectionClient + no out-of-band writes per region" invariant is unenforced
angle: frontend-state
severity: medium
category: arch
is_workaround: false
subsystem: src/store/*Bridge.ts
evidence:
  - src/store/agentsBridge.ts:166
  - src/store/settingsBridge.ts:131
  - src/store/fileBrowsersBridge.ts:194
  - src/store/connectionsBridge.ts:142
status: open
---

## What
The eleven projection bridges do not agree on how they protect their cached `lastView`
against out-of-order / stale updates:

- **Three guard explicitly** with a monotonic `lastAppliedVersion` check plus a JSON-signature
  de-dupe: `agentsBridge.commitAgentsView` (`:166-180`, `if (version < lastAppliedVersion) return`),
  `settingsBridge.commitSettingsView` (`:131-145`), `fileBrowsersBridge.commitFileBrowsersView`
  (`:194-208`). These are exactly the bridges that **also** have an out-of-band `seedRegion`
  mirror path (appStore → region) that can race the projection stream.
- **The rest apply every frame verbatim** with no version check: `connectionsBridge`
  (`:142-151`), `transfersBridge`, `systemMonitorBridge`, `broadcastBridge`, `workflowRunBridge`,
  `restoreCohortBridge`, and the `sessionBridge` fan-out (`fanOutSessionView`).

The unguarded bridges are correct **only** as long as (a) there is exactly one `ProjectionClient`
per region (its internal `applyDiff` gap-detection keeps that stream monotonic) and (b) nothing
ever writes `lastView` out of band. Neither invariant is asserted anywhere; it holds by
convention. The bridges that violate it (out-of-band seed) had to add the version guard, which
demonstrates the invariant is real and load-bearing.

## Why it matters
This is a latent-consistency and maintainability hazard rather than an active bug: the moment a
second writer, a second client, a test seam left wired in production, or a future "re-seed on
reconnect" path is added to an unguarded bridge, a stale view can silently overwrite a newer one
with no error — the exact class the three guarded bridges already defend against. Because the
protection is per-bridge and ad hoc, a reviewer cannot tell from one bridge whether omitting the
guard is safe or a bug.

## Evidence
- Guarded: `agentsBridge.ts:166`, `settingsBridge.ts:131`, `fileBrowsersBridge.ts:194`.
- Unguarded verbatim commit: `connectionsBridge.ts:142-151`; same pattern in `transfersBridge`,
  `systemMonitorBridge`, `broadcastBridge`, `workflowRunBridge`, `restoreCohortBridge`, and
  `sessionBridge` fan-out.

## Recommendation
Push the version/monotonicity guard down into a shared bridge helper (e.g. `ProjectionClient`
already tracks `version`; expose a `commitIfNewer` used by every bridge) so all eleven bridges
gain identical stale-drop semantics for free, and the "single writer per region" invariant is
enforced by construction rather than convention. Failing that, document per bridge why the guard
is omitted.
