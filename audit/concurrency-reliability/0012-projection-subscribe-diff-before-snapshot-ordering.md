---
id: CONC-012
title: Projection diffs can reach the client before the snapshot is adopted (redundant resync + transient regression)
angle: concurrency-reliability
severity: low
category: reliability
is_workaround: false
subsystem: src/services/transport
evidence:
  - src/services/transport/TauriTransport.ts:27
  - src/services/transport/TauriTransport.ts:30
  - src/services/transport/ProjectionClient.ts:110
  - src/services/transport/ProjectionClient.ts:193
  - src/services/transport/ProjectionClient.ts:216
status: open
---

## What

On subscribe, `TauriTransport` wires `channel.onmessage = onFrame` **before** awaiting the
`projection_subscribe` command that returns the snapshot (`TauriTransport.ts:27-30`).
`ProjectionClient.start` adopts the snapshot only *after* that await resolves
(`ProjectionClient.ts:110-115`). The Tauri IPC channel (events) and the command return value (a
Promise) are separate delivery mechanisms with no cross-guarantee that the snapshot Promise resolves
before the first channel message is dispatched to JS.

So a diff frame `base=N → v=N+1`, published immediately after the backend inserted the subscriber at
version N, can arrive at `onFrame` while `this.version` is still `-1`. `applyDiff` sees
`diff.baseVersion (N) !== this.version (-1)` and triggers `resync()` (`ProjectionClient.ts:193`).

## Why it matters

The design self-heals — the gap check plus `resync` (`:216`) re-baselines — so there is no
permanent corruption. But:

- Every such subscribe incurs an **extra resync round-trip** (redundant backend work + latency),
  and under a busy region this can happen on many subscribes.
- If the `resync`-adopt (async) resolves **before** the original subscribe-adopt (`adoptSnapshot(N)`
  runs synchronously right after the await), the client momentarily **regresses** from version N+1
  back to N, then re-resyncs on the next diff. Transient stale/regressed view flashes are possible.

## Evidence

```ts
const channel = new Channel<ProjectionFrame>();
channel.onmessage = onFrame;                                  // wired first
const snapshot = await invoke<SnapshotFrame>("projection_subscribe", { ... });  // resolves later
```

```ts
this.subscription = await this.transport.subscribe(this.region, onFrame);
this.adoptSnapshot(this.subscription.snapshot);               // snapshot adopted only after await
```

## Recommendation

Buffer frames that arrive before the snapshot is adopted and apply them in order once the baseline
is set (or drop any with `version <= snapshot.version`), instead of falling into `resync`. Simplest:
in `ProjectionClient`, queue frames while `version < 0` and flush after `adoptSnapshot`; guard
`adoptSnapshot` so a later resync snapshot never regresses `version`. Low severity (self-healing)
but removes avoidable resync churn and the momentary regression.
</content>
