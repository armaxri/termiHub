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
  transferPause: vi.fn(() => Promise.resolve(true)),
  transferResume: vi.fn(() => Promise.resolve(true)),
  transferCancel: vi.fn(() => Promise.resolve(true)),
  transferRetry: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  };
});

import { TransferQueue } from "./TransferQueue";
import { TransferQueueIndicator } from "./TransferQueueIndicator";
import { TooltipProvider, toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { transferCancel, transferPause, transferResume, transferRetry } from "@/services/api";
import { ensureTransfersSubscribed, currentTransfersView } from "@/store/transfersBridge";
import type { TransferEntry } from "@/types/transfer";
import {
  fakeTransferEntry,
  installTransferHarness,
  transfersView,
  type FakeTransferTransport,
} from "@/test/transferHarness";

function entry(overrides: Partial<TransferEntry> = {}): TransferEntry {
  return fakeTransferEntry("t1", {
    sessionId: "sess-a",
    name: "file.txt",
    state: "active",
    transferred: 10,
    totalBytes: 100,
    percent: 10,
    speedBytesPerSec: null,
    ...overrides,
  });
}

let container: HTMLDivElement;
let root: Root;
let transport: FakeTransferTransport;
let teardown: () => void;

/** Seed the authoritative region with the given rows (the panel renders from it). */
function seed(entries: TransferEntry[], minimized = false) {
  transport.seed(transfersView(entries, minimized));
}

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function queryAll(selector: string): Element[] {
  return Array.from(container.querySelectorAll(selector));
}

const flush = () => act(async () => await Promise.resolve());

describe("TransferQueue panel", () => {
  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState());
    ({ transport, teardown } = installTransferHarness());
    await ensureTransfersSubscribed();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    teardown();
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

  it("Minimize dispatches transfer.setMinimized(true)", async () => {
    seed([entry()]);
    act(() =>
      root.render(
        <TooltipProvider>
          <TransferQueue />
        </TooltipProvider>
      )
    );
    act(() => query("transfer-minimize")?.click());
    await flush();
    expect(transport.dispatched).toContainEqual(
      expect.objectContaining({ kind: "transfer.setMinimized", payload: { minimized: true } })
    );
    expect(currentTransfersView().minimized).toBe(true);
  });

  it("Clear Completed dispatches transfer.clearCompleted, dropping only completed rows", async () => {
    seed([entry({ id: "done", state: "completed" }), entry({ id: "live", state: "active" })]);
    act(() =>
      root.render(
        <TooltipProvider>
          <TransferQueue />
        </TooltipProvider>
      )
    );
    act(() => query("transfer-clear-completed")?.click());
    await flush();
    expect(transport.kinds()).toContain("transfer.clearCompleted");
    const q = currentTransfersView().queue;
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

  // Honest controls (audit FEC-004 / UX-016): the per-row actions must reflect
  // the real backend outcome — success only on a true state change, an accurate
  // message on a silent no-op, and an error toast on a rejection.
  function renderPanel(entries: TransferEntry[]) {
    seed(entries);
    act(() =>
      root.render(
        <TooltipProvider>
          <TransferQueue />
        </TooltipProvider>
      )
    );
  }

  it("Pause toasts success only when the backend accepts it (returns true)", async () => {
    vi.mocked(transferPause).mockResolvedValueOnce(true);
    renderPanel([entry({ id: "t1", state: "active" })]);
    await act(async () => {
      query("transfer-pause")?.click();
    });
    expect(transferPause).toHaveBeenCalledWith("t1");
    expect(toast.success).toHaveBeenCalledWith("Transfer paused");
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("Pause does NOT toast success on a backend no-op (returns false)", async () => {
    vi.mocked(transferPause).mockResolvedValueOnce(false);
    renderPanel([entry({ id: "t1", state: "active" })]);
    await act(async () => {
      query("transfer-pause")?.click();
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Pause isn't available for this transfer");
  });

  it("Pause surfaces an error toast (not silence) when the command rejects", async () => {
    vi.mocked(transferPause).mockRejectedValueOnce(new Error("session gone"));
    renderPanel([entry({ id: "t1", state: "active" })]);
    await act(async () => {
      query("transfer-pause")?.click();
    });
    expect(toast.error).toHaveBeenCalledWith("Failed to pause transfer");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("Resume does NOT toast success on a backend no-op (returns false)", async () => {
    vi.mocked(transferResume).mockResolvedValueOnce(false);
    renderPanel([entry({ id: "t1", state: "paused" })]);
    await act(async () => {
      query("transfer-resume")?.click();
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Resume isn't available for this transfer");
  });

  it("Retry does NOT toast success on a backend no-op (returns false)", async () => {
    vi.mocked(transferRetry).mockResolvedValueOnce(false);
    renderPanel([entry({ id: "t1", state: "failed" })]);
    await act(async () => {
      query("transfer-retry")?.click();
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Retry isn't available for this transfer");
  });

  it("Retry surfaces an error toast when the command rejects", async () => {
    vi.mocked(transferRetry).mockRejectedValueOnce(new Error("boom"));
    renderPanel([entry({ id: "t1", state: "failed" })]);
    await act(async () => {
      query("transfer-retry")?.click();
    });
    expect(toast.error).toHaveBeenCalledWith("Failed to retry transfer");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("Cancel reports an accurate message when nothing was cancelled (returns false)", async () => {
    vi.mocked(transferCancel).mockResolvedValueOnce(false);
    renderPanel([entry({ id: "t1", state: "active" })]);
    await act(async () => {
      query("transfer-cancel")?.click();
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Transfer already finished");
  });
});

describe("TransferQueueIndicator (minimized)", () => {
  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState());
    ({ transport, teardown } = installTransferHarness());
    await ensureTransfersSubscribed();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    teardown();
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

  it("shows a live count when minimized and restores the panel on click", async () => {
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
    await flush();
    expect(transport.dispatched).toContainEqual(
      expect.objectContaining({ kind: "transfer.setMinimized", payload: { minimized: false } })
    );
  });
});
