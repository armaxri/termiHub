import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve("persisted-id")),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  transferPause: vi.fn(() => Promise.resolve()),
  transferResume: vi.fn(() => Promise.resolve()),
  transferCancel: vi.fn(() => Promise.resolve()),
  transferRetry: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  };
});

import { TransferQueue } from "./TransferQueue";
import { TransferQueueIndicator } from "./TransferQueueIndicator";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { transferCancel } from "@/services/api";
import type { TransferEntry } from "@/types/transfer";

function entry(overrides: Partial<TransferEntry> = {}): TransferEntry {
  return {
    id: "t1",
    sessionId: "sess-a",
    direction: "download",
    name: "file.txt",
    state: "active",
    transferred: 10,
    totalBytes: 100,
    percent: 10,
    speedBytesPerSec: null,
    updatedAt: 0,
    ...overrides,
  };
}

function seed(entries: TransferEntry[], minimized = false) {
  const map: Record<string, TransferEntry> = {};
  for (const e of entries) map[e.id] = e;
  useAppStore.setState({ transferQueue: map, transferQueueMinimized: minimized });
}

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function queryAll(selector: string): Element[] {
  return Array.from(container.querySelectorAll(selector));
}

describe("TransferQueue panel", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing when the queue is empty", () => {
    seed([]);
    act(() =>
      root.render(
        <TooltipProvider>
          <TransferQueue />
        </TooltipProvider>
      )
    );
    expect(query("transfer-queue")).toBeNull();
  });

  it("renders a row per transfer", () => {
    seed([entry({ id: "t1" }), entry({ id: "t2", name: "other.bin" })]);
    act(() =>
      root.render(
        <TooltipProvider>
          <TransferQueue />
        </TooltipProvider>
      )
    );
    expect(query("transfer-queue")).not.toBeNull();
    expect(queryAll('[data-testid="transfer-row"]')).toHaveLength(2);
  });

  it("hides the panel when minimized (indicator takes over)", () => {
    seed([entry()], true);
    act(() =>
      root.render(
        <TooltipProvider>
          <TransferQueue />
        </TooltipProvider>
      )
    );
    expect(query("transfer-queue")).toBeNull();
  });

  it("Minimize collapses the panel to the status bar", () => {
    seed([entry()]);
    act(() =>
      root.render(
        <TooltipProvider>
          <TransferQueue />
        </TooltipProvider>
      )
    );
    act(() => query("transfer-minimize")?.click());
    expect(useAppStore.getState().transferQueueMinimized).toBe(true);
  });

  it("Clear Completed removes only completed rows", () => {
    seed([entry({ id: "done", state: "completed" }), entry({ id: "live", state: "active" })]);
    act(() =>
      root.render(
        <TooltipProvider>
          <TransferQueue />
        </TooltipProvider>
      )
    );
    act(() => query("transfer-clear-completed")?.click());
    const q = useAppStore.getState().transferQueue;
    expect(q["done"]).toBeUndefined();
    expect(q["live"]).toBeDefined();
  });

  it("Cancel All cancels every non-terminal transfer", async () => {
    seed([
      entry({ id: "a", state: "active" }),
      entry({ id: "q", state: "queued" }),
      entry({ id: "p", state: "paused" }),
      entry({ id: "done", state: "completed" }),
    ]);
    act(() =>
      root.render(
        <TooltipProvider>
          <TransferQueue />
        </TooltipProvider>
      )
    );
    await act(async () => {
      query("transfer-cancel-all")?.click();
    });
    expect(transferCancel).toHaveBeenCalledWith("a");
    expect(transferCancel).toHaveBeenCalledWith("q");
    expect(transferCancel).toHaveBeenCalledWith("p");
    expect(transferCancel).not.toHaveBeenCalledWith("done");
  });
});

describe("TransferQueueIndicator (minimized)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing when not minimized", () => {
    seed([entry()], false);
    act(() =>
      root.render(
        <TooltipProvider>
          <TransferQueueIndicator />
        </TooltipProvider>
      )
    );
    expect(query("transfer-queue-indicator")).toBeNull();
  });

  it("renders nothing when minimized but the queue is empty", () => {
    seed([], true);
    act(() =>
      root.render(
        <TooltipProvider>
          <TransferQueueIndicator />
        </TooltipProvider>
      )
    );
    expect(query("transfer-queue-indicator")).toBeNull();
  });

  it("shows a live count when minimized and restores the panel on click", () => {
    seed([entry({ id: "a", state: "active" }), entry({ id: "b", state: "active" })], true);
    act(() =>
      root.render(
        <TooltipProvider>
          <TransferQueueIndicator />
        </TooltipProvider>
      )
    );
    const indicator = query("transfer-queue-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("2");
    act(() => indicator?.click());
    expect(useAppStore.getState().transferQueueMinimized).toBe(false);
  });
});
