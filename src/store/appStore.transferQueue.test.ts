import { describe, it, expect, beforeEach, vi } from "vitest";

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
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(() => Promise.resolve()),
  sftpListDir: vi.fn(() => Promise.resolve([])),
  sftpRealpath: vi.fn(() => Promise.resolve("/home/alice")),
  sftpCancelTransfer: vi.fn(() => Promise.resolve()),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import { useAppStore } from "./appStore";
import type { TransferProgress } from "@/services/api";
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

function progress(overrides: Partial<TransferProgress> = {}): TransferProgress {
  return {
    transferId: "t1",
    sessionId: "sess-a",
    direction: "download",
    fileName: "file.txt",
    transferred: 0,
    total: 100,
    phase: "transferring",
    ...overrides,
  };
}

describe("appStore — transfer queue slice (#1337)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("starts with an empty, non-minimized queue", () => {
    expect(useAppStore.getState().transferQueue).toEqual({});
    expect(useAppStore.getState().transferQueueMinimized).toBe(false);
  });

  it("addTransfer inserts an entry keyed by id", () => {
    useAppStore.getState().addTransfer(entry());
    expect(useAppStore.getState().transferQueue["t1"]).toMatchObject({ id: "t1", state: "active" });
  });

  it("updateTransfer merges a patch by id", () => {
    useAppStore.getState().addTransfer(entry());
    useAppStore.getState().updateTransfer("t1", { transferred: 50, percent: 50 });
    expect(useAppStore.getState().transferQueue["t1"]).toMatchObject({
      transferred: 50,
      percent: 50,
      state: "active",
    });
  });

  it("updateTransfer is a no-op for an unknown id", () => {
    useAppStore.getState().updateTransfer("missing", { transferred: 5 });
    expect(useAppStore.getState().transferQueue["missing"]).toBeUndefined();
  });

  it("removeTransfer drops a single entry", () => {
    useAppStore.getState().addTransfer(entry({ id: "t1" }));
    useAppStore.getState().addTransfer(entry({ id: "t2" }));
    useAppStore.getState().removeTransfer("t1");
    expect(useAppStore.getState().transferQueue["t1"]).toBeUndefined();
    expect(useAppStore.getState().transferQueue["t2"]).toBeDefined();
  });

  it("clearCompleted removes only completed entries, keeping failed/cancelled/active", () => {
    const store = useAppStore.getState();
    store.addTransfer(entry({ id: "done", state: "completed" }));
    store.addTransfer(entry({ id: "fail", state: "failed" }));
    store.addTransfer(entry({ id: "cxl", state: "cancelled" }));
    store.addTransfer(entry({ id: "live", state: "active" }));

    store.clearCompleted();

    const q = useAppStore.getState().transferQueue;
    expect(q["done"]).toBeUndefined();
    expect(q["fail"]).toBeDefined();
    expect(q["cxl"]).toBeDefined();
    expect(q["live"]).toBeDefined();
  });

  it("setTransferQueueMinimized toggles the minimized flag", () => {
    useAppStore.getState().setTransferQueueMinimized(true);
    expect(useAppStore.getState().transferQueueMinimized).toBe(true);
    useAppStore.getState().setTransferQueueMinimized(false);
    expect(useAppStore.getState().transferQueueMinimized).toBe(false);
  });

  describe("applyTransferProgressToQueue", () => {
    it("adds a row on the first event and persists terminal rows", () => {
      const store = useAppStore.getState();
      store.applyTransferProgressToQueue(progress({ transferred: 20 }));
      expect(useAppStore.getState().transferQueue["t1"]).toMatchObject({
        state: "active",
        transferred: 20,
      });

      // A terminal event keeps the row visible (unlike the transient #1247 map).
      store.applyTransferProgressToQueue(progress({ phase: "done", transferred: 100 }));
      expect(useAppStore.getState().transferQueue["t1"]).toMatchObject({
        state: "completed",
        percent: 100,
      });
    });

    it("merges subsequent events into the same row", () => {
      const store = useAppStore.getState();
      store.applyTransferProgressToQueue(progress({ transferred: 20 }));
      store.applyTransferProgressToQueue(progress({ transferred: 60 }));
      const q = useAppStore.getState().transferQueue;
      expect(Object.keys(q)).toHaveLength(1);
      expect(q["t1"].transferred).toBe(60);
    });
  });
});
