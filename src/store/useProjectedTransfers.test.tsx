/**
 * `useProjectedTransfers` — the Transfer Queue panel cut to the projected
 * `transfers` region (#2229 render cut). Drives the hook against an in-memory
 * substrate double and asserts: flag-off returns the appStore slice and dispatches
 * nothing; flag-on seeds the region (a `transfer.replace` mirror) and then renders
 * the slice from the projection, value-identical to appStore; and a region that
 * has not caught up falls back to the appStore slice.
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
import type { TransferEntry } from "@/types/transfer";

import {
  setTransferRenderFromProjectionEnabled,
  setTransferTransportForTest,
  stopTransfersSubscription,
  TRANSFERS_REGION,
  type TransfersView,
} from "./transfersBridge";
import { useProjectedTransfers } from "./useProjectedTransfers";

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

function entry(id: string, overrides: Partial<TransferEntry> = {}): TransferEntry {
  return {
    id,
    sessionId: "sess-a",
    direction: "download",
    name: `file-${id}`,
    state: "active",
    transferred: 40,
    totalBytes: 100,
    percent: 40,
    speedBytesPerSec: 2048,
    updatedAt: 0,
    ...overrides,
  };
}

function queueOf(...rows: TransferEntry[]): Record<string, TransferEntry> {
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

/** In-memory substrate double: applies `transfer.replace` and fans a snapshot. */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  /** When false, `transfer.replace` acks but does NOT advance the region. */
  applyReplace = true;
  private view: Record<string, unknown> = { queue: {}, minimized: false };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "transfer.replace" && this.applyReplace) {
      const p = intent.payload as Record<string, unknown>;
      this.view = JSON.parse(
        JSON.stringify({ queue: p.queue ?? {}, minimized: p.minimized ?? false })
      );
      this.version += 1;
      this.fan();
    }
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: TRANSFERS_REGION, version: this.version }],
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
    const frame: ProjectionFrame = this.snapshot(TRANSFERS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => TransfersView; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: TransfersView = { queue: {}, minimized: false };

  function Probe() {
    latest = useProjectedTransfers();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setTransferTransportForTest(transport);
  useAppStore.setState({ transferQueue: {}, transferQueueMinimized: false });
});

afterEach(() => {
  stopTransfersSubscription();
  setTransferTransportForTest(null);
  setTransferRenderFromProjectionEnabled(null);
  useAppStore.setState({ transferQueue: {}, transferQueueMinimized: false });
});

const flush = () => act(async () => await Promise.resolve());

describe("useProjectedTransfers", () => {
  it("flag off: returns the appStore slice and dispatches nothing", async () => {
    setTransferRenderFromProjectionEnabled(false);
    const queue = queueOf(entry("t1"));
    useAppStore.setState({ transferQueue: queue, transferQueueMinimized: true });

    const hook = renderHook();
    await flush();

    expect(hook.get().queue).toEqual(queue);
    expect(hook.get().minimized).toBe(true);
    expect(transport.dispatched).toHaveLength(0);
    hook.unmount();
  });

  it("flag on: seeds the region then renders the slice from the projection", async () => {
    const queue = queueOf(entry("t1"), entry("t2", { state: "queued" }));
    useAppStore.setState({ transferQueue: queue, transferQueueMinimized: false });

    const hook = renderHook();
    await flush();
    await flush();

    // The hook seeded appStore's slice via transfer.replace…
    expect(transport.dispatched.some((d) => d.kind === "transfer.replace")).toBe(true);
    // …and now renders a value-identical slice (sourced from the projection).
    expect(hook.get().queue).toEqual(queue);
    expect(hook.get().minimized).toBe(false);
    hook.unmount();
  });

  it("region not caught up: falls back to the appStore slice", async () => {
    transport.applyReplace = false; // the replace acks but never advances the region
    const queue = queueOf(entry("solo", { path: undefined }));
    useAppStore.setState({ transferQueue: queue, transferQueueMinimized: false });

    const hook = renderHook();
    await flush();
    await flush();

    // The projection stays empty, so the gate rejects it and the hook renders the
    // appStore slice verbatim — parity preserved.
    expect(hook.get().queue).toEqual(queue);
    expect(hook.get().minimized).toBe(false);
    hook.unmount();
  });
});
