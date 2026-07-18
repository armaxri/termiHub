import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock only `transferList`, keeping the rest of the API surface real so the
// store (which imports many api symbols) still resolves.
vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return { ...actual, transferList: vi.fn() };
});

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

// Spy on `isTerminalTransferState` (keeping its real behaviour) so a test can
// prove the pending-row scan is memoized and does not re-run on unrelated store
// mutations (#1657).
vi.mock("@/types/transfer", async () => {
  const actual = await vi.importActual<typeof import("@/types/transfer")>("@/types/transfer");
  return { ...actual, isTerminalTransferState: vi.fn(actual.isTerminalTransferState) };
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useTransferReconcile } from "./useTransferReconcile";
import { useAppStore } from "@/store/appStore";
import { transferList } from "@/services/api";
import { isTerminalTransferState } from "@/types/transfer";
import type { TransferSnapshot } from "@/services/api";

const mockTransferList = vi.mocked(transferList);
const mockIsTerminal = vi.mocked(isTerminalTransferState);

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

describe("useTransferReconcile (#1645)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    mockTransferList.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mountHook(): Promise<void> {
    function Harness() {
      useTransferReconcile();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    // Let the effect's async `reconcile()` resolve.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("settles a stuck row from the backend snapshot when the terminal event was dropped", async () => {
    // A transfer was seeded (#1632) but every progress event — including the
    // terminal one — was dropped, so the row is stuck at `queued`.
    useAppStore.getState().seedTransferQueue({
      id: "t1",
      sessionId: "sess-a",
      direction: "download",
      name: "file.txt",
      path: "/remote/file.txt",
    });
    expect(useAppStore.getState().transferQueue["t1"].state).toBe("queued");

    // The backend still reports it (retained terminal snapshot, #1645).
    mockTransferList.mockResolvedValue([snapshot({ state: "completed", transferred: 100 })]);

    await mountHook();

    expect(mockTransferList).toHaveBeenCalled();
    expect(useAppStore.getState().transferQueue["t1"]).toMatchObject({
      state: "completed",
      transferred: 100,
      percent: 100,
    });
  });

  it("makes no backend call while the queue has no pending rows", async () => {
    // Only a terminal row present → nothing to reconcile → no polling.
    useAppStore.getState().addTransfer({
      id: "done",
      sessionId: "sess-a",
      direction: "download",
      name: "file.txt",
      state: "completed",
      transferred: 100,
      totalBytes: 100,
      percent: 100,
      speedBytesPerSec: null,
      updatedAt: 0,
    });

    await mountHook();

    expect(mockTransferList).not.toHaveBeenCalled();
  });

  it("does not settle a stuck row from a transient rich `failed` snapshot (settled:false, #1657)", async () => {
    // The row is seeded/stuck at `queued`; the backend reports the transfer as
    // `failed` but `settled: false` — a live rich handle mid auto-retry. The
    // reconcile must leave the row non-terminal so a later recovery can settle
    // it, rather than freezing it at `failed`.
    useAppStore.getState().seedTransferQueue({
      id: "t1",
      sessionId: "sess-a",
      direction: "download",
      name: "file.txt",
      path: "/remote/file.txt",
    });
    mockTransferList.mockResolvedValue([snapshot({ state: "failed", settled: false })]);

    await mountHook();

    expect(mockTransferList).toHaveBeenCalled();
    expect(useAppStore.getState().transferQueue["t1"].state).toBe("queued");
  });

  it("does not re-scan the queue for pending rows on an unrelated store mutation (#1657)", async () => {
    // With a pending row present, the pending-row derivation is memoized on the
    // `transferQueue` reference, so an unrelated `setState` (which leaves that
    // reference untouched) must not re-run the O(rows) scan.
    useAppStore.getState().seedTransferQueue({
      id: "t1",
      sessionId: "sess-a",
      direction: "download",
      name: "file.txt",
      path: "/remote/file.txt",
    });

    await mountHook();
    // The mount's initial render already ran the scan; from here it must not.
    mockIsTerminal.mockClear();

    act(() => {
      // A mutation to an unrelated slice — the queue reference is unchanged.
      useAppStore.setState({ tabCwds: { "tab-1": "/home/user" } });
    });

    expect(mockIsTerminal).not.toHaveBeenCalled();
  });
});
