/**
 * In-memory projection transport (#2283 slice E1) — a backend-less {@link Transport}
 * used as the layout region's fallback whenever {@link createTransport} would throw
 * (a non-Tauri environment with no remote-client socket: headless unit tests, and
 * remote-client mode before its WebSocket transport lands, #2166).
 *
 * # Why it exists
 *
 * The region→appStore layout mirror (#2283 slice E1) derives `appStore`'s layout
 * fields from the `layout@<clientId>` projection via
 * {@link ProjectionClient.dispatchOptimistic}. That path needs a *constructable*
 * transport — the client's synchronous optimistic overlay + `emit()` (which drives
 * the mirror) fire client-side, **without** waiting on any backend. So the only
 * thing a headless environment needs is a transport object that:
 *
 * - `subscribe`s and returns an (empty) baseline snapshot, and
 * - `dispatch`es an **accepted** ack carrying a `produced` version for the
 *   region, so {@link ProjectionClient.dispatchOptimistic} *keeps* its optimistic
 *   fold (an ack with no `produced` on the region is treated as a no-op and rolls
 *   the fold back — see `ProjectionClient`).
 *
 * It emits no diff frames of its own: the effective view is carried entirely by the
 * client's optimistic folds (each layout fold is a last-writer full-view replace),
 * so the mirror always sees the latest dispatched view. Because no diff ever
 * advances the cache version, the folds are never version-pruned — bounded and
 * harmless for a test process; the real {@link TauriTransport} (or the socket
 * transport) is always used in the desktop app, where the backend confirms and
 * prunes.
 */

import type { FrameHandler, Subscription, Transport } from "./Transport";
import type { Intent, IntentAck, SnapshotFrame } from "./types";

export class InMemoryTransport implements Transport {
  /** Monotonic version handed out to `produced` on every accepted dispatch. */
  private version = 0;
  /** Regions with a live subscription (so `dispatch` can report `produced`). */
  private readonly regions = new Set<string>();

  async subscribe(region: string, _onFrame: FrameHandler): Promise<Subscription> {
    this.regions.add(region);
    const snapshot: SnapshotFrame = { region, kind: "snapshot", version: 0, view: undefined };
    return {
      snapshot,
      unsubscribe: () => {
        this.regions.delete(region);
      },
    };
  }

  async dispatch(intent: Intent): Promise<IntentAck> {
    // Report a fresh version for every subscribed region so a dispatching client's
    // optimistic fold is retained (accepted-with-produced), never rolled back.
    const produced = [...this.regions].map((region) => ({ region, version: ++this.version }));
    return { intentId: intent.intentId, status: "accepted", produced };
  }

  async resync(_region: string, _have?: number): Promise<SnapshotFrame | null> {
    // No gaps are possible without a backend stream, so there is nothing to
    // re-baseline from; the client keeps its current (optimistically-folded) view.
    return null;
  }
}
