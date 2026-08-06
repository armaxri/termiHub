/**
 * Test harness for the region-authoritative connection tree sidebar (#2225).
 *
 * The sidebar ({@link import("../components/Sidebar/ConnectionList").ConnectionList})
 * reads the saved-connection / folder inventory from the authoritative
 * `connections` projection region, not from `appStore`. In production that region
 * is fed server-side (#2389 / #2394); in a unit/component test there is no backend,
 * so this harness mirrors `appStore`'s `connections` / `folders` slice into the
 * region on every change — a faithful stand-in for the server-side fold. It lets a
 * component test keep seeding `appStore` (the pre-#2225 idiom) while the sidebar
 * still renders from the region.
 *
 * Usage: call {@link setupConnectionsRegionFromAppStore} once at the top of a test
 * module (or inside a `describe`); it registers its own `beforeEach` / `afterEach`.
 */

import { afterEach, beforeEach } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import { useAppStore } from "@/store/appStore";
import {
  setConnectionsViewForTest,
  setConnectionTransportForTest,
  stopConnectionsSubscription,
  type ConnectionsView,
} from "@/store/connectionsBridge";

/** The current `appStore` connections slice in region-snapshot shape. */
function appStoreView(): ConnectionsView {
  const { folders, connections } = useAppStore.getState();
  return { folders, connections };
}

/**
 * A transport double whose region subscription snapshot always reflects the
 * current `appStore` slice — so the sidebar hook's mount-time subscribe agrees
 * with the synchronously-primed region view (no clobber back to empty). Dispatch
 * is accepted and recorded but drives nothing (mutation intents are validated in
 * the bridge unit test, not here).
 */
class AppStoreBackedTransport implements Transport {
  dispatched: Intent[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    return { intentId: intent.intentId, status: "accepted", produced: [] };
  }

  async subscribe(region: string, _onFrame: FrameHandler): Promise<Subscription> {
    return {
      snapshot: { kind: "snapshot", region, version: 1, view: structuredClone(appStoreView()) },
      unsubscribe: () => {},
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }
}

/**
 * Install the appStore→region mirror and return a teardown. Prefer
 * {@link setupConnectionsRegionFromAppStore}, which wires the lifecycle for you.
 */
export function installConnectionsRegionFromAppStore(): () => void {
  setConnectionTransportForTest(new AppStoreBackedTransport());
  const prime = () => setConnectionsViewForTest(appStoreView());
  prime();
  const unsubscribe = useAppStore.subscribe(prime);
  return () => {
    unsubscribe();
    stopConnectionsSubscription();
    setConnectionTransportForTest(null);
  };
}

/**
 * Register a `beforeEach` / `afterEach` pair that keeps the authoritative
 * `connections` region mirrored from `appStore` for the duration of each test in
 * the current module. Call once at module scope.
 */
export function setupConnectionsRegionFromAppStore(): void {
  let teardown: (() => void) | undefined;
  beforeEach(() => {
    teardown = installConnectionsRegionFromAppStore();
  });
  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });
}
