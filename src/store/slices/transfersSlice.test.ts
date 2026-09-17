import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { create, type StateCreator } from "zustand";

import type { TransferState } from "@/types/connection";
import { onFrontendLog } from "@/utils/frontendLog";

vi.mock("@/services/api", () => ({
  sftpCancelTransfer: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/store/transfersBridge", () => ({
  dispatchTransferIntentBestEffort: vi.fn(),
}));

// The slice pulls three pure helpers off the (not-yet-extracted) layout domain
// via `../appStore`; stub them so importing the slice does not drag in the whole
// root store. Only `applyTransferProgress` uses them, which is covered elsewhere.
vi.mock("../appStore", () => ({
  omitKey: (rec: Record<string, unknown>, key: string) => {
    const { [key]: _omit, ...rest } = rec;
    return rest;
  },
  windowOwnsTransferSession: () => true,
  withComposedLayout: (s: unknown) => s,
}));

import { sftpCancelTransfer } from "@/services/api";
import { dispatchTransferIntentBestEffort } from "@/store/transfersBridge";
import { createTransfersSlice, type TransfersSlice } from "./transfersSlice";

const mockedCancel = vi.mocked(sftpCancelTransfer);
const mockedDispatch = vi.mocked(dispatchTransferIntentBestEffort);

const makeStore = () =>
  create<TransfersSlice>()(createTransfersSlice as unknown as StateCreator<TransfersSlice>);

async function captureLogs(fn: () => Promise<void> | void): Promise<string[]> {
  const messages: string[] = [];
  const off = onFrontendLog((entry) => messages.push(entry.message));
  try {
    await fn();
  } finally {
    off();
  }
  return messages;
}

describe("transfersSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with no live transfers", () => {
    expect(store.getState().transfers).toEqual({});
  });

  describe("cancelTransfer", () => {
    it("requests cancellation via the SFTP command", async () => {
      await store.getState().cancelTransfer("t1");
      expect(mockedCancel).toHaveBeenCalledWith("t1");
    });

    it("logs and re-throws when the cancel command rejects (Error)", async () => {
      mockedCancel.mockRejectedValueOnce(new Error("cancel boom"));
      const logs = await captureLogs(async () => {
        await expect(store.getState().cancelTransfer("t2")).rejects.toThrow("cancel boom");
      });
      expect(logs.some((m) => m.includes("cancel boom") && m.includes("t2"))).toBe(true);
    });

    it("stringifies a non-Error rejection in the log (String(err) branch)", async () => {
      mockedCancel.mockRejectedValueOnce("plain failure");
      const logs = await captureLogs(async () => {
        await expect(store.getState().cancelTransfer("t3")).rejects.toBe("plain failure");
      });
      expect(logs.some((m) => m.includes("plain failure"))).toBe(true);
    });
  });

  describe("transfer-queue panel mutations", () => {
    it("removeTransfer dispatches a transfer.remove intent", () => {
      store.getState().removeTransfer("row-1");
      expect(mockedDispatch).toHaveBeenCalledWith("transfer.remove", { id: "row-1" });
    });

    it("clearCompleted dispatches a transfer.clearCompleted intent", () => {
      store.getState().clearCompleted();
      expect(mockedDispatch).toHaveBeenCalledWith("transfer.clearCompleted", {});
    });

    it("setTransferQueueMinimized dispatches a transfer.setMinimized intent", () => {
      store.getState().setTransferQueueMinimized(true);
      expect(mockedDispatch).toHaveBeenCalledWith("transfer.setMinimized", { minimized: true });
    });
  });

  describe("applyTransferProgress", () => {
    const progress = (over: Partial<TransferState> = {}): TransferState =>
      ({
        transferId: "t1",
        sessionId: "s1",
        phase: "transferring",
        direction: "download",
        transferred: 1,
        total: 10,
        ...over,
      }) as unknown as TransferState;

    beforeEach(() => {
      store.setState({ releasedTransferSessions: [] } as unknown as Partial<TransfersSlice>);
    });

    it("upserts a live transferring row and clears it on a terminal phase", () => {
      store.getState().applyTransferProgress(progress());
      expect(store.getState().transfers.t1).toBeDefined();
      store.getState().applyTransferProgress(progress({ phase: "done" }));
      expect(store.getState().transfers.t1).toBeUndefined();
    });

    it("ignores a terminal phase for a transfer that was never tracked", () => {
      store.getState().applyTransferProgress(progress({ transferId: "ghost", phase: "error" }));
      expect(store.getState().transfers.ghost).toBeUndefined();
    });
  });
});
