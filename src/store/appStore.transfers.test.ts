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
import {
  sftpClose,
  sftpCancelTransfer,
  listSessionOwners,
  type TransferProgress,
} from "@/services/api";

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

describe("appStore — SFTP transfer progress (S2/D3)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    vi.mocked(sftpClose).mockResolvedValue(undefined);
    vi.mocked(sftpCancelTransfer).mockResolvedValue(undefined);
  });

  describe("applyTransferProgress drives the transfers map", () => {
    it("adds a row on the first transferring event", () => {
      useAppStore.getState().applyTransferProgress(progress());

      const t = useAppStore.getState().transfers["t1"];
      expect(t).toEqual({
        transferId: "t1",
        sessionId: "sess-a",
        direction: "download",
        fileName: "file.txt",
        transferred: 0,
        total: 100,
        phase: "transferring",
      });
    });

    it("updates the same row (bytes/phase) on subsequent transferring events", () => {
      const store = useAppStore.getState();
      store.applyTransferProgress(progress());
      store.applyTransferProgress(progress({ transferred: 50 }));

      const transfers = useAppStore.getState().transfers;
      expect(Object.keys(transfers)).toHaveLength(1);
      expect(transfers["t1"].transferred).toBe(50);
    });

    it("tracks multiple concurrent transfers independently", () => {
      const store = useAppStore.getState();
      store.applyTransferProgress(progress({ transferId: "t1" }));
      store.applyTransferProgress(progress({ transferId: "t2", sessionId: "sess-b" }));

      const transfers = useAppStore.getState().transfers;
      expect(Object.keys(transfers).sort()).toEqual(["t1", "t2"]);
    });
  });

  describe("terminal-phase cleanup clears the row", () => {
    it.each(["done", "cancelled", "error"] as const)("clears the row on %s", (phase) => {
      const store = useAppStore.getState();
      store.applyTransferProgress(progress());
      expect(useAppStore.getState().transfers["t1"]).toBeDefined();

      store.applyTransferProgress(progress({ phase }));
      expect(useAppStore.getState().transfers["t1"]).toBeUndefined();
    });

    it("leaves other transfers intact when one reaches a terminal phase", () => {
      const store = useAppStore.getState();
      store.applyTransferProgress(progress({ transferId: "t1" }));
      store.applyTransferProgress(progress({ transferId: "t2" }));

      store.applyTransferProgress(progress({ transferId: "t1", phase: "done" }));

      const transfers = useAppStore.getState().transfers;
      expect(transfers["t1"]).toBeUndefined();
      expect(transfers["t2"]).toBeDefined();
    });
  });

  describe("window-scoped folding (#1964)", () => {
    it("folds a transfer for a session with no ownership entry (background / single-window)", () => {
      // sessionOwners is empty by default → unclaimed session folds everywhere,
      // preserving single-window behavior and background/spawned transfers.
      useAppStore.getState().applyTransferProgress(progress({ sessionId: "sess-a" }));
      expect(useAppStore.getState().transfers["t1"]).toBeDefined();
    });

    it("suppresses a transfer for a session owned by another window", () => {
      useAppStore.setState({ windowLabel: "main", sessionOwners: { "sess-a": "win-1" } });
      useAppStore.getState().applyTransferProgress(progress({ sessionId: "sess-a" }));
      expect(useAppStore.getState().transfers["t1"]).toBeUndefined();
    });

    it("folds a transfer for a session this window owns in the map", () => {
      useAppStore.setState({ windowLabel: "main", sessionOwners: { "sess-a": "main" } });
      useAppStore.getState().applyTransferProgress(progress({ sessionId: "sess-a" }));
      expect(useAppStore.getState().transfers["t1"]).toBeDefined();
    });

    it("folds a transfer this window renders locally even if a stale map says otherwise", () => {
      // An SFTP sidebar session in this window's own store is authoritative for
      // this window, regardless of how stale the ownership snapshot is.
      useAppStore.setState({
        windowLabel: "main",
        sessionOwners: { "sess-a": "win-1" },
        sftpSessions: { "sess-a": { hostLabel: "alice@a:22", owningTabId: "tab-1" } },
      });
      useAppStore.getState().applyTransferProgress(progress({ sessionId: "sess-a" }));
      expect(useAppStore.getState().transfers["t1"]).toBeDefined();
    });
  });

  describe("setSessionOwners prunes foreign rows (#1964)", () => {
    it("drops a folded row once the map shows another window owns its session", () => {
      const store = useAppStore.getState();
      store.applyTransferProgress(progress({ transferId: "t1", sessionId: "sess-a" }));
      expect(useAppStore.getState().transfers["t1"]).toBeDefined();

      useAppStore.getState().setSessionOwners({ "sess-a": "win-1" });
      expect(useAppStore.getState().transfers["t1"]).toBeUndefined();
    });

    it("keeps rows for sessions this window owns or renders locally", () => {
      useAppStore.setState({
        windowLabel: "main",
        sftpSessions: { "sess-local": { hostLabel: "alice@a:22", owningTabId: "tab-1" } },
      });
      const store = useAppStore.getState();
      store.applyTransferProgress(progress({ transferId: "t-own", sessionId: "sess-own" }));
      store.applyTransferProgress(progress({ transferId: "t-local", sessionId: "sess-local" }));
      store.applyTransferProgress(progress({ transferId: "t-foreign", sessionId: "sess-foreign" }));

      useAppStore.getState().setSessionOwners({
        "sess-own": "main",
        "sess-local": "win-1", // stale — but locally rendered, so kept
        "sess-foreign": "win-1",
      });

      const transfers = useAppStore.getState().transfers;
      expect(transfers["t-own"]).toBeDefined();
      expect(transfers["t-local"]).toBeDefined();
      expect(transfers["t-foreign"]).toBeUndefined();
    });
  });

  describe("refreshSessionOwners", () => {
    it("mirrors the backend map and prunes foreign rows", async () => {
      vi.mocked(listSessionOwners).mockResolvedValueOnce({ "sess-a": "win-1" });
      useAppStore
        .getState()
        .applyTransferProgress(progress({ transferId: "t1", sessionId: "sess-a" }));
      expect(useAppStore.getState().transfers["t1"]).toBeDefined();

      await useAppStore.getState().refreshSessionOwners();

      expect(useAppStore.getState().sessionOwners).toEqual({ "sess-a": "win-1" });
      expect(useAppStore.getState().transfers["t1"]).toBeUndefined();
    });

    it("leaves the map unchanged when the backend refetch fails", async () => {
      useAppStore.setState({ sessionOwners: { "sess-a": "main" } });
      vi.mocked(listSessionOwners).mockRejectedValueOnce(new Error("ipc down"));

      await useAppStore.getState().refreshSessionOwners();

      expect(useAppStore.getState().sessionOwners).toEqual({ "sess-a": "main" });
    });
  });

  describe("cancelTransfer", () => {
    it("invokes sftpCancelTransfer with the id", async () => {
      useAppStore.getState().applyTransferProgress(progress());
      await useAppStore.getState().cancelTransfer("t1");
      expect(sftpCancelTransfer).toHaveBeenCalledWith("t1");
    });
  });

  describe("kill-cascade: closeSftpSession cancels the session's transfers first", () => {
    it("cancels every transfer owned by the session before closing it", async () => {
      const order: string[] = [];
      vi.mocked(sftpCancelTransfer).mockImplementation((id: string) => {
        order.push(`cancel:${id}`);
        return Promise.resolve();
      });
      vi.mocked(sftpClose).mockImplementation((id: string) => {
        order.push(`close:${id}`);
        return Promise.resolve();
      });

      useAppStore.setState({
        sftpSessions: { "sess-a": { hostLabel: "alice@a:22", owningTabId: "tab-gone" } },
      });
      const store = useAppStore.getState();
      store.applyTransferProgress(progress({ transferId: "t1", sessionId: "sess-a" }));
      store.applyTransferProgress(progress({ transferId: "t2", sessionId: "sess-a" }));
      // A transfer on a different session must not be cancelled.
      store.applyTransferProgress(progress({ transferId: "t3", sessionId: "sess-b" }));

      await useAppStore.getState().closeSftpSession("sess-a");

      expect(sftpCancelTransfer).toHaveBeenCalledWith("t1");
      expect(sftpCancelTransfer).toHaveBeenCalledWith("t2");
      expect(sftpCancelTransfer).not.toHaveBeenCalledWith("t3");
      // Cancel of the session's transfers happens before the session is closed.
      expect(order.indexOf("cancel:t1")).toBeLessThan(order.indexOf("close:sess-a"));
      expect(order.indexOf("cancel:t2")).toBeLessThan(order.indexOf("close:sess-a"));

      // The unrelated transfer survives.
      expect(useAppStore.getState().transfers["t3"]).toBeDefined();
    });

    it("closes a session with no transfers without cancelling anything", async () => {
      useAppStore.setState({
        sftpSessions: { "sess-a": { hostLabel: "alice@a:22", owningTabId: "tab-gone" } },
      });

      await useAppStore.getState().closeSftpSession("sess-a");

      expect(sftpCancelTransfer).not.toHaveBeenCalled();
      expect(sftpClose).toHaveBeenCalledWith("sess-a");
    });
  });
});
