import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock only `transferList`, keeping the rest of the API surface real so the
// store (which imports many api symbols) still resolves.
vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return { ...actual, transferList: vi.fn() };
});

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useTransferReconcile } from "./useTransferReconcile";
import { useAppStore } from "@/store/appStore";
import { transferList } from "@/services/api";
import { currentTransfersView, ensureTransfersSubscribed } from "@/store/transfersBridge";
import type { TransferSnapshot } from "@/services/api";
import {
  fakeTransferEntry,
  installTransferHarness,
  transfersView,
  type FakeTransferTransport,
} from "@/test/transferHarness";

const mockTransferList = vi.mocked(transferList);

function snapshot(overrides: Partial<TransferSnapshot> = {}): TransferSnapshot {
  return {
    transferId: "t1",
    sessionId: "sess-a",
    direction: "download",
    fileName: "file.txt",
    path: "/remote/file.txt",
    state: "completed",
    settled: true,
    transferred: 100,
    total: 100,
    speed: 0,
    attempt: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

describe("useTransferReconcile (#1645, region-authoritative #2229)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let transport: FakeTransferTransport;
  let teardown: () => void;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    ({ transport, teardown } = installTransferHarness());
    await ensureTransfersSubscribed();
    vi.clearAllMocks();
    mockTransferList.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    teardown();
  });

  async function mountHook(): Promise<void> {
    function Harness() {
      useTransferReconcile();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    // Let the effect's async `reconcile()` resolve and the dispatch round-trip.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("settles a stuck row via transfer.reconcile when the terminal event was dropped", async () => {
    // A transfer is stuck at `queued` (every progress event, incl. terminal, was
    // dropped); the backend still reports it (retained terminal snapshot, #1645).
    transport.seed(
      transfersView([fakeTransferEntry("t1", { state: "queued", percent: null })])
    );
    mockTransferList.mockResolvedValue([snapshot({ state: "completed", transferred: 100 })]);

    await mountHook();

    expect(mockTransferList).toHaveBeenCalled();
    expect(transport.kinds()).toContain("transfer.reconcile");
    expect(currentTransfersView().queue["t1"]).toMatchObject({
      state: "completed",
      transferred: 100,
      percent: 100,
    });
  });

  it("makes no backend call while the queue has no pending rows", async () => {
    // Only a terminal row present → nothing to reconcile → no polling.
    transport.seed(
      transfersView([fakeTransferEntry("done", { state: "completed", percent: 100 })])
    );

    await mountHook();

    expect(mockTransferList).not.toHaveBeenCalled();
    expect(transport.kinds()).not.toContain("transfer.reconcile");
  });

  it("does not settle a stuck row from a transient rich `failed` snapshot (settled:false, #1657)", async () => {
    // The backend reports the transfer as `failed` but `settled: false` — a live
    // rich handle mid auto-retry. The reconcile must leave the row non-terminal.
    transport.seed(
      transfersView([fakeTransferEntry("t1", { state: "queued", percent: null })])
    );
    mockTransferList.mockResolvedValue([snapshot({ state: "failed", settled: false })]);

    await mountHook();

    expect(mockTransferList).toHaveBeenCalled();
    expect(currentTransfersView().queue["t1"].state).toBe("queued");
  });
});
