/**
 * Broadcast mutation cut (#2242, part of #2206 / #2139) — cut-vs-local parity.
 *
 * The mutation cut routes each broadcast membership action through a granular
 * `broadcast.*` intent so the backend `BroadcastStore` becomes authoritative, while
 * the local `appStore` reducer path stays in place as the render source and the
 * resilience / rollback fallback (the reducer removal is a later step).
 *
 * These tests prove the cut is parity-safe: with the flag **on**, the intents the
 * actions dispatch — applied by a faithful in-memory port of the Rust store
 * (mirroring `broadcast_projection/store.rs`) — reproduce the exact `appStore`
 * broadcast slice (`broadcastActive` / `broadcastSourceTabId` / `broadcastScope` /
 * `broadcastTargetTabIds` / `lastBroadcastScope`) for every action. With the flag
 * **off**, no intents are dispatched and the local slice is byte-identical — the
 * instant rollback path the flip relies on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import type { BroadcastScope } from "@/types/terminal";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

import { useAppStore } from "./appStore";
import { setBroadcastIntentsEnabled, setBroadcastTransportForTest } from "./broadcastBridge";

interface RegionView {
  active: boolean;
  sourceTabId: string | null;
  scope: BroadcastScope;
  targetTabIds: string[];
  lastScope: BroadcastScope;
}

const EMPTY: RegionView = {
  active: false,
  sourceTabId: null,
  scope: "all",
  targetTabIds: [],
  lastScope: "all",
};

/** Append `{source} ∪ targets`, source first, de-duped — twin of `ordered_targets`. */
function orderedTargets(source: string, targets: string[]): string[] {
  const out = [source];
  for (const id of targets) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * An in-memory substrate double applying the granular `broadcast.*` intents with
 * the same semantics as the Rust `BroadcastStore`, so a run of the real `appStore`
 * actions (which mirror those intents) reconstructs the region view the broadcast
 * UI would render. `broadcast.replace` (the render-cut mirror) is intentionally not
 * applied — the mutation cut drives the region through the per-transition intents.
 */
class BroadcastStoreTransport implements Transport {
  dispatched: Intent[] = [];
  private view: RegionView = { ...EMPTY };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    this.apply(intent);
    this.version += 1;
    this.fan();
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: "broadcast@test", version: this.version }],
    };
  }

  private apply(intent: Intent): void {
    const p = intent.payload as Record<string, unknown>;
    switch (intent.kind) {
      case "broadcast.start": {
        const scope = p.scope as BroadcastScope;
        const source = p.sourceTabId as string;
        const targets = (p.targetTabIds as string[]) ?? [];
        this.view = {
          active: true,
          sourceTabId: source,
          scope,
          targetTabIds: orderedTargets(source, targets),
          lastScope: scope,
        };
        break;
      }
      case "broadcast.stop": {
        // Retains scope / lastScope, exactly like the reducer.
        this.view = { ...this.view, active: false, sourceTabId: null, targetTabIds: [] };
        break;
      }
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
      default:
        break;
    }
  }

  regionView(): RegionView {
    return structuredClone(this.view);
  }

  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
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
    return { kind: "snapshot", region, version: this.version, view: this.regionView() };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot("broadcast@test");
    for (const h of this.handlers) h(frame);
  }
}

let transport: BroadcastStoreTransport;

/** Assert the region the intents reconstruct equals the local appStore slice. */
function expectParity() {
  const s = useAppStore.getState();
  const region = transport.regionView();
  expect(region.active).toBe(s.broadcastActive);
  expect(region.sourceTabId).toBe(s.broadcastSourceTabId);
  expect(region.scope).toBe(s.broadcastScope);
  expect(region.lastScope).toBe(s.lastBroadcastScope);
  // Membership compares as a set (order-independent — the UI reads `.has()`/`.size`).
  expect(new Set(region.targetTabIds)).toEqual(s.broadcastTargetTabIds);
}

beforeEach(() => {
  useAppStore.setState({
    broadcastActive: false,
    broadcastSourceTabId: null,
    broadcastScope: "all",
    broadcastTargetTabIds: new Set<string>(),
    lastBroadcastScope: "all",
  });
  transport = new BroadcastStoreTransport();
  setBroadcastTransportForTest(transport);
  setBroadcastIntentsEnabled(true);
});

afterEach(() => {
  setBroadcastTransportForTest(null);
  setBroadcastIntentsEnabled(null);
});

describe("broadcast mutation cut — cut-vs-local parity (flag on)", () => {
  it("startBroadcast reproduces the active membership (source first)", () => {
    useAppStore.getState().startBroadcast("panel", "src", ["src", "t1", "t2"]);
    expect(transport.kinds()).toEqual(["broadcast.start"]);
    expectParity();
    expect(transport.regionView().active).toBe(true);
    expect(transport.regionView().targetTabIds).toEqual(["src", "t1", "t2"]);
    expect(transport.regionView().lastScope).toBe("panel");
  });

  it("addTarget then removeTarget stay in parity", () => {
    useAppStore.getState().startBroadcast("all", "src", ["t1"]);
    useAppStore.getState().addBroadcastTarget("t2");
    expectParity();
    expect(new Set(transport.regionView().targetTabIds)).toEqual(new Set(["src", "t1", "t2"]));

    useAppStore.getState().removeBroadcastTarget("t1");
    expectParity();
    expect(new Set(transport.regionView().targetTabIds)).toEqual(new Set(["src", "t2"]));
  });

  it("a no-op add / remove dispatches nothing (matches the pure store)", () => {
    useAppStore.getState().startBroadcast("all", "src", ["t1"]);
    transport.dispatched.length = 0;
    // t1 already a target; ghost never was.
    useAppStore.getState().addBroadcastTarget("t1");
    useAppStore.getState().removeBroadcastTarget("ghost");
    expect(transport.kinds()).toEqual([]);
    expectParity();
  });

  it("stopBroadcast leaves broadcast but retains scope / lastScope", () => {
    useAppStore.getState().startBroadcast("panel", "src", ["t1"]);
    useAppStore.getState().stopBroadcast();
    expect(transport.kinds()).toEqual(["broadcast.start", "broadcast.stop"]);
    expectParity();
    const region = transport.regionView();
    expect(region.active).toBe(false);
    expect(region.sourceTabId).toBeNull();
    expect(region.targetTabIds).toEqual([]);
    // Retained for the keyboard toggle (#1958).
    expect(region.scope).toBe("panel");
    expect(region.lastScope).toBe("panel");
  });

  it("a restart supersedes the prior session in parity", () => {
    useAppStore.getState().startBroadcast("all", "src1", ["t1", "t2"]);
    useAppStore.getState().startBroadcast("custom", "src2", ["t3"]);
    expectParity();
    expect(transport.regionView().sourceTabId).toBe("src2");
    expect(new Set(transport.regionView().targetTabIds)).toEqual(new Set(["src2", "t3"]));
    expect(transport.regionView().scope).toBe("custom");
  });
});

describe("broadcast mutation cut — flag off (instant rollback)", () => {
  beforeEach(() => setBroadcastIntentsEnabled(false));

  it("dispatches nothing and the local slice is unchanged", () => {
    useAppStore.getState().startBroadcast("panel", "src", ["t1"]);
    useAppStore.getState().addBroadcastTarget("t2");
    useAppStore.getState().removeBroadcastTarget("t1");
    useAppStore.getState().stopBroadcast();

    expect(transport.dispatched).toHaveLength(0);
    // The region double never advanced past its idle baseline.
    expect(transport.regionView()).toEqual(EMPTY);
    // But the local slice applied every transition (source retained scope after stop).
    const s = useAppStore.getState();
    expect(s.broadcastActive).toBe(false);
    expect(s.broadcastScope).toBe("panel");
    expect(s.lastBroadcastScope).toBe("panel");
  });
});
