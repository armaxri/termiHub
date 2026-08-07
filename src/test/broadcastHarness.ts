/**
 * Test harness for the authoritative `broadcast@<clientId>` projection region
 * (#2206).
 *
 * Since the broadcast reducer removal made the region the single source of truth,
 * tests can no longer seed broadcast membership into `appStore` — they seed it into
 * the region. {@link FakeBroadcastTransport} is an in-memory twin of the Rust
 * `BroadcastStore`: it holds one broadcast view, folds the granular `broadcast.*`
 * intents exactly as the backend store does (`start` / `stop` / `toggle` /
 * `addTarget` / `removeTarget`), and fans a fresh snapshot to every subscriber.
 * {@link seed} pre-populates the view for a test's initial render;
 * {@link FakeBroadcastTransport.dispatched} records dispatched intents for
 * assertions.
 *
 * Broadcast is client-scoped, but a checkout mutates and subscribes to its own
 * single region, so the harness tracks one view keyed to {@link BROADCAST_REGION}.
 */

import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import {
  BROADCAST_REGION,
  EMPTY_BROADCAST_VIEW,
  setBroadcastTransportForTest,
  stopBroadcastSubscription,
  type BroadcastView,
} from "@/store/broadcastBridge";
import type { BroadcastScope } from "@/types/terminal";

/** Build a broadcast view from a partial (idle baseline for the rest). */
export function broadcastView(over: Partial<BroadcastView> = {}): BroadcastView {
  return { ...EMPTY_BROADCAST_VIEW, ...over };
}

/** `{source} ∪ targets`, source first, de-duped — mirrors the Rust `ordered_targets`. */
function orderedTargets(source: string, targets: string[]): string[] {
  const out = [source];
  for (const id of targets) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * An in-memory substrate double for the `broadcast` region: holds one view, folds
 * the granular `broadcast.*` intents like the Rust store, and fans a snapshot to
 * every subscriber. Faithful enough that a client-dispatched intent round-trips
 * back into the projected view.
 */
export class FakeBroadcastTransport implements Transport {
  dispatched: Intent[] = [];
  private view: BroadcastView = { ...EMPTY_BROADCAST_VIEW };
  private version = 0;
  private handlers = new Set<FrameHandler>();

  /** Seed the region view directly (test setup), fanning a snapshot. */
  seed(view: Partial<BroadcastView>): void {
    this.view = broadcastView(view);
    this.bump();
  }

  /** Intent kinds dispatched, in order (assertion helper). */
  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    const p = intent.payload as Record<string, unknown>;
    switch (intent.kind) {
      case "broadcast.start":
        this.start(
          p.scope as BroadcastScope,
          p.sourceTabId as string,
          (p.targetTabIds as string[]) ?? []
        );
        break;
      case "broadcast.stop":
        this.view = {
          ...this.view,
          active: false,
          sourceTabId: null,
          targetTabIds: [],
        };
        break;
      case "broadcast.toggle":
        if (this.view.active) {
          this.view = { ...this.view, active: false, sourceTabId: null, targetTabIds: [] };
        } else if (typeof p.sourceTabId === "string") {
          this.start(
            (p.scope as BroadcastScope) ?? "all",
            p.sourceTabId,
            (p.targetTabIds as string[]) ?? []
          );
        }
        break;
      case "broadcast.addTarget": {
        const tabId = p.tabId as string;
        if (!this.view.targetTabIds.includes(tabId)) {
          this.view = { ...this.view, targetTabIds: [...this.view.targetTabIds, tabId] };
        }
        break;
      }
      case "broadcast.removeTarget": {
        const tabId = p.tabId as string;
        this.view = {
          ...this.view,
          targetTabIds: this.view.targetTabIds.filter((id) => id !== tabId),
        };
        break;
      }
      case "broadcast.replace":
        this.view = broadcastView(p as Partial<BroadcastView>);
        break;
      default:
        return { intentId: intent.intentId, status: "accepted", produced: [] };
    }
    this.bump();
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: BROADCAST_REGION, version: this.version }],
    };
  }

  private start(scope: BroadcastScope, source: string, targets: string[]): void {
    this.view = {
      ...this.view,
      active: true,
      scope,
      lastScope: scope,
      sourceTabId: source,
      targetTabIds: orderedTargets(source, targets),
    };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.add(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => this.handlers.delete(onFrame),
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private bump(): void {
    this.version += 1;
    const frame = this.snapshot(BROADCAST_REGION);
    for (const h of this.handlers) h(frame);
  }
}

/**
 * Install a {@link FakeBroadcastTransport} as the broadcast bridge's transport and
 * optionally seed it. Returns the transport plus a `teardown` that drops the
 * subscription and restores the real transport — call it in `afterEach`.
 */
export function installBroadcastHarness(initial?: Partial<BroadcastView>): {
  transport: FakeBroadcastTransport;
  teardown: () => void;
} {
  const transport = new FakeBroadcastTransport();
  setBroadcastTransportForTest(transport);
  if (initial) transport.seed(initial);
  return {
    transport,
    teardown: () => {
      stopBroadcastSubscription();
      setBroadcastTransportForTest(null);
    },
  };
}
