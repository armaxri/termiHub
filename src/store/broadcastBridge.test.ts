/**
 * Broadcast-membership projection bridge (#2242) — flags, the faithful-mirror
 * gate, and the `broadcast.replace` seed round-trip. Drives the bridge against an
 * in-memory substrate double that applies `broadcast.replace` and fans a snapshot,
 * without a backend.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

import {
  BROADCAST_REGION,
  broadcastIntentsEnabled,
  broadcastRenderFromProjectionEnabled,
  broadcastViewMirrors,
  currentBroadcastView,
  ensureBroadcastSubscribed,
  EMPTY_BROADCAST_VIEW,
  onBroadcastView,
  seedBroadcastRegion,
  setBroadcastIntentsEnabled,
  setBroadcastRenderFromProjectionEnabled,
  setBroadcastTransportForTest,
  stopBroadcastSubscription,
  type BroadcastSlice,
  type BroadcastView,
} from "./broadcastBridge";

/** An in-memory substrate double: holds one broadcast view, applies a
 * `broadcast.replace` by overwriting it, and fans a fresh snapshot to subscribers. */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  private view: BroadcastView = { ...EMPTY_BROADCAST_VIEW };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "broadcast.replace") {
      const p = intent.payload as Partial<BroadcastView>;
      this.view = {
        active: p.active ?? false,
        sourceTabId: p.sourceTabId ?? null,
        scope: p.scope ?? "all",
        targetTabIds: p.targetTabIds ?? [],
        lastScope: p.lastScope ?? "all",
      };
      this.version += 1;
      this.fan();
      return {
        intentId: intent.intentId,
        status: "accepted",
        produced: [{ region: BROADCAST_REGION, version: this.version }],
      };
    }
    return { intentId: intent.intentId, status: "accepted", produced: [] };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.push(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== onFrame);
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(BROADCAST_REGION);
    for (const h of this.handlers) h(frame);
  }
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setBroadcastTransportForTest(transport);
});

afterEach(() => {
  stopBroadcastSubscription();
  setBroadcastTransportForTest(null);
  setBroadcastRenderFromProjectionEnabled(null);
  setBroadcastIntentsEnabled(null);
});

describe("broadcastRenderFromProjectionEnabled flag", () => {
  it("defaults on and honours the programmatic override", () => {
    expect(broadcastRenderFromProjectionEnabled()).toBe(true);
    setBroadcastRenderFromProjectionEnabled(false);
    expect(broadcastRenderFromProjectionEnabled()).toBe(false);
    setBroadcastRenderFromProjectionEnabled(true);
    expect(broadcastRenderFromProjectionEnabled()).toBe(true);
    setBroadcastRenderFromProjectionEnabled(null);
    expect(broadcastRenderFromProjectionEnabled()).toBe(true);
  });
});

describe("broadcastIntentsEnabled flag", () => {
  it("defaults on and honours the programmatic override", () => {
    expect(broadcastIntentsEnabled()).toBe(true);
    setBroadcastIntentsEnabled(false);
    expect(broadcastIntentsEnabled()).toBe(false);
    setBroadcastIntentsEnabled(null);
    expect(broadcastIntentsEnabled()).toBe(true);
  });
});

function slice(over: Partial<BroadcastSlice> = {}): BroadcastSlice {
  return {
    active: false,
    sourceTabId: null,
    scope: "all",
    targetTabIds: new Set<string>(),
    lastScope: "all",
    ...over,
  };
}

describe("broadcastViewMirrors gate", () => {
  it("is false for an undefined view", () => {
    expect(broadcastViewMirrors(undefined, slice())).toBe(false);
  });

  it("mirrors when every field matches (targets order-independent)", () => {
    const view: BroadcastView = {
      active: true,
      sourceTabId: "src",
      scope: "panel",
      targetTabIds: ["src", "t1", "t2"],
      lastScope: "panel",
    };
    // Same members, different order — still a mirror (the UI reads set membership).
    const s = slice({
      active: true,
      sourceTabId: "src",
      scope: "panel",
      targetTabIds: new Set(["t2", "src", "t1"]),
      lastScope: "panel",
    });
    expect(broadcastViewMirrors(view, s)).toBe(true);
  });

  it("rejects on any field divergence", () => {
    const view: BroadcastView = {
      active: true,
      sourceTabId: "src",
      scope: "all",
      targetTabIds: ["src"],
      lastScope: "all",
    };
    expect(broadcastViewMirrors(view, slice({ active: false }))).toBe(false);
    expect(
      broadcastViewMirrors(view, slice({ active: true, sourceTabId: "src", scope: "panel" }))
    ).toBe(false);
    // Same size, different member.
    expect(
      broadcastViewMirrors(
        view,
        slice({ active: true, sourceTabId: "src", targetTabIds: new Set(["x"]) })
      )
    ).toBe(false);
  });
});

describe("seedBroadcastRegion (broadcast.replace mirror)", () => {
  const view: BroadcastView = {
    active: true,
    sourceTabId: "src",
    scope: "custom",
    targetTabIds: ["src", "t1"],
    lastScope: "custom",
  };

  it("dispatches a broadcast.replace and fans the mirrored view", async () => {
    const received: BroadcastView[] = [];
    onBroadcastView((v) => received.push(v));
    await ensureBroadcastSubscribed();

    await seedBroadcastRegion(view);

    const replace = transport.dispatched.filter((d) => d.kind === "broadcast.replace");
    expect(replace).toHaveLength(1);
    expect(currentBroadcastView()).toEqual(view);
    expect(received[received.length - 1]).toEqual(view);
  });

  it("de-duplicates an identical seed", async () => {
    await ensureBroadcastSubscribed();
    await seedBroadcastRegion(view);
    await seedBroadcastRegion(view);
    expect(transport.dispatched.filter((d) => d.kind === "broadcast.replace")).toHaveLength(1);
  });
});
