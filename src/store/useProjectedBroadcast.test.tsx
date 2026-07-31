/**
 * `useProjectedBroadcast` — the broadcast UI cut to the projected `broadcast`
 * region (#2242 render cut). Drives the hook against an in-memory substrate double
 * and asserts: flag-off returns the appStore slice and dispatches nothing; flag-on
 * seeds the region (a `broadcast.replace` mirror) and then renders the slice from
 * the projection, value-identical to appStore; and a region that has not caught up
 * falls back to the appStore slice.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import { useAppStore } from "@/store/appStore";

import {
  BROADCAST_REGION,
  EMPTY_BROADCAST_VIEW,
  setBroadcastRenderFromProjectionEnabled,
  setBroadcastTransportForTest,
  stopBroadcastSubscription,
  type BroadcastSlice,
  type BroadcastView,
} from "./broadcastBridge";
import { useProjectedBroadcast } from "./useProjectedBroadcast";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], powerMonitoringEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

/** In-memory substrate double: applies `broadcast.replace` and fans a snapshot. */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  /** When false, `broadcast.replace` acks but does NOT advance the region. */
  applyReplace = true;
  private view: BroadcastView = { ...EMPTY_BROADCAST_VIEW };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "broadcast.replace" && this.applyReplace) {
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
    }
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: BROADCAST_REGION, version: this.version }],
    };
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

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => BroadcastSlice; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: BroadcastSlice = {
    active: false,
    sourceTabId: null,
    scope: "all",
    targetTabIds: new Set(),
    lastScope: "all",
  };

  function Probe() {
    latest = useProjectedBroadcast();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

let transport: FakeTransport;

/** Set the appStore broadcast slice for a test. */
function setBroadcast(over: {
  active: boolean;
  sourceTabId: string | null;
  scope: BroadcastView["scope"];
  targetTabIds: string[];
  lastScope: BroadcastView["lastScope"];
}) {
  useAppStore.setState({
    broadcastActive: over.active,
    broadcastSourceTabId: over.sourceTabId,
    broadcastScope: over.scope,
    broadcastTargetTabIds: new Set(over.targetTabIds),
    lastBroadcastScope: over.lastScope,
  });
}

beforeEach(() => {
  transport = new FakeTransport();
  setBroadcastTransportForTest(transport);
  setBroadcast({
    active: false,
    sourceTabId: null,
    scope: "all",
    targetTabIds: [],
    lastScope: "all",
  });
});

afterEach(() => {
  stopBroadcastSubscription();
  setBroadcastTransportForTest(null);
  setBroadcastRenderFromProjectionEnabled(null);
});

const flush = () => act(async () => await Promise.resolve());

describe("useProjectedBroadcast", () => {
  it("flag off: returns the appStore slice and dispatches nothing", async () => {
    setBroadcastRenderFromProjectionEnabled(false);
    setBroadcast({
      active: true,
      sourceTabId: "src",
      scope: "panel",
      targetTabIds: ["src", "t1"],
      lastScope: "panel",
    });

    const hook = renderHook();
    await flush();

    expect(hook.get().active).toBe(true);
    expect(hook.get().sourceTabId).toBe("src");
    expect([...hook.get().targetTabIds].sort()).toEqual(["src", "t1"]);
    expect(transport.dispatched).toHaveLength(0);
    hook.unmount();
  });

  it("flag on: seeds the region then renders the slice from the projection", async () => {
    setBroadcast({
      active: true,
      sourceTabId: "src",
      scope: "custom",
      targetTabIds: ["src", "t1", "t2"],
      lastScope: "custom",
    });

    const hook = renderHook();
    await flush();
    await flush();

    // Seeded appStore's slice via broadcast.replace…
    expect(transport.dispatched.some((d) => d.kind === "broadcast.replace")).toBe(true);
    // …and now renders a value-identical slice (sourced from the projection).
    const s = hook.get();
    expect(s.active).toBe(true);
    expect(s.sourceTabId).toBe("src");
    expect(s.scope).toBe("custom");
    expect([...s.targetTabIds].sort()).toEqual(["src", "t1", "t2"]);
    expect(s.lastScope).toBe("custom");
    hook.unmount();
  });

  it("region not caught up: falls back to the appStore slice", async () => {
    transport.applyReplace = false; // the replace acks but never advances the region
    setBroadcast({
      active: true,
      sourceTabId: "src",
      scope: "all",
      targetTabIds: ["src"],
      lastScope: "all",
    });

    const hook = renderHook();
    await flush();
    await flush();

    // The projection stays empty, so the gate rejects it and the hook renders the
    // appStore slice verbatim — parity preserved.
    const s = hook.get();
    expect(s.active).toBe(true);
    expect([...s.targetTabIds]).toEqual(["src"]);
    hook.unmount();
  });
});
