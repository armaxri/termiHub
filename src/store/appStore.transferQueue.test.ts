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
  claimSession: vi.fn(() => Promise.resolve(null)),
  releaseSession: vi.fn(() => Promise.resolve(true)),
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import { useAppStore } from "./appStore";
import type { TransferProgress, TransferSnapshot } from "@/services/api";
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

  describe("window-scoped queue folding (#1964)", () => {
    it("adds a queue row for a session with no ownership entry (single-window / background)", () => {
      useAppStore.getState().applyTransferProgressToQueue(progress({ sessionId: "sess-a" }));
      expect(useAppStore.getState().transferQueue["t1"]).toBeDefined();
    });

    it("suppresses a queue row for a session owned by another window", () => {
      useAppStore.setState({ windowLabel: "main", sessionOwners: { "sess-a": "win-1" } });
      useAppStore.getState().applyTransferProgressToQueue(progress({ sessionId: "sess-a" }));
      expect(useAppStore.getState().transferQueue["t1"]).toBeUndefined();
    });

    it("adds a queue row for a session this window owns", () => {
      useAppStore.setState({ windowLabel: "main", sessionOwners: { "sess-a": "main" } });
      useAppStore.getState().applyTransferProgressToQueue(progress({ sessionId: "sess-a" }));
      expect(useAppStore.getState().transferQueue["t1"]).toBeDefined();
    });

    it("prunes a foreign queue row once ownership is learned", () => {
      useAppStore.getState().applyTransferProgressToQueue(progress({ sessionId: "sess-a" }));
      expect(useAppStore.getState().transferQueue["t1"]).toBeDefined();

      useAppStore.getState().setSessionOwners({ "sess-a": "win-1" });
      expect(useAppStore.getState().transferQueue["t1"]).toBeUndefined();
    });
  });

  describe("seedTransferQueue (#1632)", () => {
    it("opens the panel by adding a queued row without any transfer-progress event", () => {
      // The reported failure: every `transfer-progress` event for a transfer is
      // dropped/delayed under memory pressure, so the panel never opens. Seeding
      // from the registration snapshot makes the slice non-empty on its own.
      expect(useAppStore.getState().transferQueue).toEqual({});

      useAppStore.getState().seedTransferQueue({
        id: "seed-1",
        sessionId: "sess-a",
        direction: "download",
        name: "file.txt",
        path: "/remote/file.txt",
      });

      const row = useAppStore.getState().transferQueue["seed-1"];
      expect(row).toMatchObject({
        id: "seed-1",
        sessionId: "sess-a",
        direction: "download",
        name: "file.txt",
        path: "/remote/file.txt",
        state: "queued",
        transferred: 0,
        totalBytes: null,
        percent: null,
      });
    });

    it("is idempotent — never clobbers a row an event already advanced", () => {
      const store = useAppStore.getState();
      // An event arrives first and advances the row well past `queued`…
      store.applyTransferProgressToQueue(
        progress({ transferId: "t1", phase: "done", transferred: 100 })
      );
      // …then a late seed for the same id must not reset it to `queued`.
      store.seedTransferQueue({
        id: "t1",
        sessionId: "sess-a",
        direction: "download",
        name: "file.txt",
      });
      expect(useAppStore.getState().transferQueue["t1"]).toMatchObject({
        state: "completed",
        transferred: 100,
        percent: 100,
      });
    });

    it("a later event upserts (does not duplicate) a seeded row", () => {
      const store = useAppStore.getState();
      store.seedTransferQueue({
        id: "t1",
        sessionId: "sess-a",
        direction: "download",
        name: "file.txt",
      });
      store.applyTransferProgressToQueue(progress({ transferId: "t1", transferred: 40 }));

      const q = useAppStore.getState().transferQueue;
      expect(Object.keys(q)).toHaveLength(1);
      expect(q["t1"]).toMatchObject({ state: "active", transferred: 40 });
    });

    it("carries a known total (upload) through to the seeded row", () => {
      useAppStore.getState().seedTransferQueue({
        id: "up-1",
        sessionId: "sess-a",
        direction: "upload",
        name: "big.bin",
        totalBytes: 2048,
      });
      expect(useAppStore.getState().transferQueue["up-1"]).toMatchObject({
        direction: "upload",
        totalBytes: 2048,
        state: "queued",
      });
    });
  });

  describe("reconcileTransferQueue (#1645)", () => {
    it("settles a stuck seeded row when its terminal event was never delivered", () => {
      // The exact #1645 scenario: a transfer is seeded (#1632), completes on the
      // backend, but *every* transfer-progress event — including the terminal
      // one — is dropped. The row is stuck at `queued`; a backend snapshot must
      // settle it to `completed`.
      const store = useAppStore.getState();
      store.seedTransferQueue({
        id: "t1",
        sessionId: "sess-a",
        direction: "download",
        name: "file.txt",
        path: "/remote/file.txt",
      });
      expect(useAppStore.getState().transferQueue["t1"].state).toBe("queued");

      store.reconcileTransferQueue([snapshot({ state: "completed", transferred: 100 })]);

      expect(useAppStore.getState().transferQueue["t1"]).toMatchObject({
        state: "completed",
        transferred: 100,
        percent: 100,
      });
    });

    it("settles a stuck active row to failed/cancelled from a terminal snapshot", () => {
      const store = useAppStore.getState();
      store.addTransfer(entry({ id: "t1", state: "active", transferred: 40 }));
      store.reconcileTransferQueue([snapshot({ state: "failed", settled: true, transferred: 40 })]);
      expect(useAppStore.getState().transferQueue["t1"]).toMatchObject({ state: "failed" });
    });

    it("does NOT settle a row from a transient rich `failed` snapshot (settled:false, #1657)", () => {
      // A rich (FTP) transfer that is momentarily `failed` mid auto-retry — or
      // awaiting a manual retry — lists as `failed` but `settled: false`. The
      // reconcile must leave the row non-terminal, so a subsequent recovery (or
      // its dropped terminal event) can still settle it correctly.
      const store = useAppStore.getState();
      store.addTransfer(entry({ id: "t1", state: "active", transferred: 40, percent: 40 }));
      store.reconcileTransferQueue([
        snapshot({ state: "failed", settled: false, transferred: 40 }),
      ]);
      expect(useAppStore.getState().transferQueue["t1"]).toMatchObject({
        state: "active",
        transferred: 40,
      });
    });

    it("is idempotent — never clobbers a row an event already settled", () => {
      const store = useAppStore.getState();
      // An event already settled the row to cancelled…
      store.applyTransferProgressToQueue(progress({ phase: "cancelled", transferred: 20 }));
      expect(useAppStore.getState().transferQueue["t1"].state).toBe("cancelled");
      // …a later snapshot reporting a different terminal state must not override.
      store.reconcileTransferQueue([snapshot({ state: "completed", transferred: 100 })]);
      expect(useAppStore.getState().transferQueue["t1"]).toMatchObject({
        state: "cancelled",
        transferred: 20,
      });
    });

    it("does not move a live (active) row — a non-terminal snapshot is ignored", () => {
      const store = useAppStore.getState();
      store.addTransfer(entry({ id: "t1", state: "active", transferred: 60, percent: 60 }));
      // A lagging snapshot that still reads active/0 must not regress the row.
      store.reconcileTransferQueue([snapshot({ state: "active", transferred: 0 })]);
      expect(useAppStore.getState().transferQueue["t1"]).toMatchObject({
        state: "active",
        transferred: 60,
      });
    });

    it("does not resurrect a row that is not (or no longer) in the queue", () => {
      const store = useAppStore.getState();
      store.reconcileTransferQueue([snapshot({ transferId: "ghost", state: "completed" })]);
      expect(useAppStore.getState().transferQueue["ghost"]).toBeUndefined();
    });

    it("settles only the stuck rows, leaving others untouched", () => {
      const store = useAppStore.getState();
      store.seedTransferQueue({ id: "stuck", sessionId: "s", direction: "download", name: "a" });
      store.addTransfer(entry({ id: "done", state: "completed" }));
      store.reconcileTransferQueue([
        snapshot({ transferId: "stuck", state: "completed" }),
        snapshot({ transferId: "done", state: "cancelled" }), // must be ignored (already terminal)
      ]);
      const q = useAppStore.getState().transferQueue;
      expect(q["stuck"].state).toBe("completed");
      expect(q["done"].state).toBe("completed");
    });
  });
});
