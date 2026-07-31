/**
 * TransferQueue render cut (#2229) — the panel reads its rows + minimized flag
 * from the projected `transfers` region via {@link useProjectedTransfers}. Drives
 * the real component against an in-memory substrate double and asserts: it renders
 * the rows sourced from the projection (and seeds it from appStore), and it falls
 * back to the appStore slice verbatim when the region has not caught up — parity
 * preserved either way.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui";
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
  setTransferRenderFromProjectionEnabled,
  setTransferTransportForTest,
  stopTransfersSubscription,
  TRANSFERS_REGION,
} from "@/store/transfersBridge";
import type { TransferEntry } from "@/types/transfer";

import { TransferQueue } from "./TransferQueue";
import { TransferQueueIndicator } from "./TransferQueueIndicator";

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
    name: `file-${id}.bin`,
    path: `/pub/file-${id}.bin`,
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

let transport: FakeTransport;
let container: HTMLDivElement;
let root: Root;

const flush = () => act(async () => await Promise.resolve());

beforeEach(() => {
  transport = new FakeTransport();
  setTransferTransportForTest(transport);
  useAppStore.setState({ transferQueue: {}, transferQueueMinimized: false });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  stopTransfersSubscription();
  setTransferTransportForTest(null);
  setTransferRenderFromProjectionEnabled(null);
  useAppStore.setState({ transferQueue: {}, transferQueueMinimized: false });
});

function renderQueue() {
  act(() => {
    root.render(
      <TooltipProvider>
        <TransferQueue />
      </TooltipProvider>
    );
  });
}

describe("TransferQueue render cut (#2229)", () => {
  it("renders the queue rows sourced from the projection and seeds it from appStore", async () => {
    const queue = queueOf(entry("aaa"), entry("bbb", { state: "queued" }));
    useAppStore.setState({ transferQueue: queue });

    renderQueue();
    await flush();
    await flush();
    renderQueue();

    // The panel is populated and shows both rows.
    expect(container.querySelector('[data-testid="transfer-queue"]')).not.toBeNull();
    expect(container.textContent).toContain("file-aaa.bin");
    expect(container.textContent).toContain("file-bbb.bin");
    // …and the region was seeded to mirror appStore.
    expect(transport.dispatched.some((d) => d.kind === "transfer.replace")).toBe(true);
  });

  it("falls back to the appStore slice when the region has not caught up (parity)", async () => {
    transport.applyReplace = false; // the replace acks but never advances the region
    const queue = queueOf(entry("ccc"));
    useAppStore.setState({ transferQueue: queue });

    renderQueue();
    await flush();
    await flush();
    renderQueue();

    // The projection stayed empty; the panel still renders the appStore row verbatim.
    expect(container.textContent).toContain("file-ccc.bin");
  });
});

describe("TransferQueueIndicator render cut (#2229)", () => {
  it("renders the minimized indicator from the projected slice", async () => {
    const queue = queueOf(entry("aaa"));
    useAppStore.setState({ transferQueue: queue, transferQueueMinimized: true });

    act(() => {
      root.render(
        <TooltipProvider>
          <TransferQueueIndicator />
        </TooltipProvider>
      );
    });
    await flush();
    await flush();
    act(() => {
      root.render(
        <TooltipProvider>
          <TransferQueueIndicator />
        </TooltipProvider>
      );
    });

    const indicator = container.querySelector('[data-testid="transfer-queue-indicator"]');
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("1 transferring");
  });
});
