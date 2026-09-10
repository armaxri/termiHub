---
id: FEC-007
title: WebSocketTransport allows only one subscriber per region and never tears down its notification listener
angle: frontend-components
severity: low
category: bug
is_workaround: false
subsystem: src/services/transport
evidence:
  - src/services/transport/WebSocketTransport.ts:32
  - src/services/transport/WebSocketTransport.ts:48
  - src/services/transport/WebSocketTransport.ts:78
status: open
---

## What
`WebSocketTransport.subscribe` stores frame handlers in
`Map<region, FrameHandler>` and does `this.handlers.set(region, onFrame)`. Two
subscriptions to the same region collide: the second overwrites the first, and
either `unsubscribe` deletes the shared entry. The `TauriTransport` sibling does
not have this limitation — it opens a distinct per-subscription `Channel` keyed
by a unique `subscriptionId`, so N subscribers to one region each get their own
delivery path.

The `projection.frame` notification listener registered by `ensureListener()`
(`notificationHandle`) is also never invoked on unsubscribe or any teardown — the
class has no `close()`/`dispose()`, so the socket notification handler outlives
all subscriptions.

## Why it matters
The two `Transport` implementations must be behaviourally interchangeable
(`ProjectionClient` is written against the interface). `ProjectionClient`
currently keeps one client per region so the collision is not hit today, but the
divergence is a latent correctness gap: any code that subscribes two consumers
to one region works on Tauri and silently breaks on WebSocket. This transport is
the remote-client substrate ("Phase 2 … does not exist yet" per the file
header), so it will be exercised later without this being noticed now.

## Evidence
`src/services/transport/WebSocketTransport.ts:32,48,62,78-84` vs.
`src/services/transport/TauriTransport.ts:25-46`.

## Recommendation
Key handlers by `subscriptionId` (as Tauri keys by channel), routing
`projection.frame` to all handlers registered for `frame.region`; delete only
the unsubscribing entry. Add a `close()` that calls `notificationHandle?.()` and
clears the map, and call it when the transport is torn down.
