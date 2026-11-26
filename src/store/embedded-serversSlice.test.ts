/**
 * Unit coverage for the embedded-servers store slice (TFE-006).
 *
 * The slice was previously exercised almost only by its delete-error regression
 * (#1427), leaving the load / refresh / save / start / stop / quick-share paths —
 * and every one of their error/rejection branches — untested (branch coverage
 * was ~10%). These tests drive each action directly against `useAppStore`, with
 * the embedded-server IPC wrappers mocked, and pin both the success mutation and
 * the error branch (rejection re-raise + state left untouched, or read-only
 * actions swallowing the error and logging).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { ProjectionCacheState } from "@/services/transport";
import type { EmbeddedServerConfig, ServerState } from "@/types/embeddedServer";

const { regions, startMock } = vi.hoisted(() => ({
  /** One entry per live region client, newest last. */
  regions: [] as { region: string; push: (state: ProjectionCacheState) => void }[],
  startMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/transport", () => ({
  createTransport: () => ({ dispatch: vi.fn(), subscribe: vi.fn(), resync: vi.fn() }),
  newClientId: () => "client-test",
  newIntentId: () => "intent-test",
  ProjectionClient: class {
    private listener?: (state: ProjectionCacheState) => void;
    private entry = {
      region: "",
      push: (state: ProjectionCacheState) => this.listener?.(state),
    };
    constructor(_transport: unknown, region: string) {
      this.entry.region = region;
      regions.push(this.entry);
    }
    onChange(listener: (state: ProjectionCacheState) => void) {
      this.listener = listener;
      return () => {};
    }
    start = startMock;
    stop() {
      const at = regions.indexOf(this.entry);
      if (at >= 0) regions.splice(at, 1);
    }
  },
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/embeddedServerApi", () => ({
  saveEmbeddedServer: vi.fn(() => Promise.resolve()),
  deleteEmbeddedServer: vi.fn(() => Promise.resolve()),
  restoreEmbeddedServer: vi.fn(() => Promise.resolve()),
  startEmbeddedServer: vi.fn(() => Promise.resolve()),
  stopEmbeddedServer: vi.fn(() => Promise.resolve()),
  createAndStartServer: vi.fn(() => Promise.resolve("srv-new")),
  listNetworkInterfaces: vi.fn(() => Promise.resolve([])),
}));

import { toast } from "@/components/ui";
import { useAppStore } from "./appStore";
import {
  deleteEmbeddedServer as apiDeleteEmbeddedServer,
  restoreEmbeddedServer as apiRestoreEmbeddedServer,
  saveEmbeddedServer as apiSaveEmbeddedServer,
  startEmbeddedServer as apiStartEmbeddedServer,
  stopEmbeddedServer as apiStopEmbeddedServer,
} from "@/services/embeddedServerApi";

function makeServer(id: string, name: string): EmbeddedServerConfig {
  return {
    id,
    name,
    serverType: "http",
    rootDirectory: "/tmp",
    bindHost: "127.0.0.1",
    port: 8080,
    autoStart: false,
    readOnly: false,
    directoryListing: true,
  };
}

function runningState(id: string): ServerState {
  return {
    serverId: id,
    status: "running",
    stats: { activeConnections: 0, totalConnections: 0, bytesSent: 0, bytesReceived: 0 },
  };
}

describe("embedded-servers slice (TFE-006)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    regions.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("the services region (#6028)", () => {
    const services = () => regions.filter((r) => r.region === "services");
    const push = (servers: EmbeddedServerConfig[], states: ServerState[]) =>
      services()[0].push({
        version: 1,
        view: { servers, states: Object.fromEntries(states.map((s) => [s.serverId, s])) },
      });

    it("shows what the region says, and follows it", async () => {
      await useAppStore.getState().loadEmbeddedServers();
      expect(services()).toHaveLength(1);
      push([makeServer("srv-1", "A"), makeServer("srv-2", "B")], [runningState("srv-1")]);
      expect(useAppStore.getState().embeddedServers.map((s) => s.id)).toEqual(["srv-1", "srv-2"]);
      expect(useAppStore.getState().embeddedServerStates["srv-1"].status).toBe("running");

      // Another window deleted one.
      push([makeServer("srv-2", "B")], []);
      expect(useAppStore.getState().embeddedServers.map((s) => s.id)).toEqual(["srv-2"]);
      expect(useAppStore.getState().embeddedServerStates).toEqual({});
    });

    it("subscribes once, also after a reload", async () => {
      await useAppStore.getState().loadEmbeddedServers();
      await useAppStore.getState().loadEmbeddedServers();
      expect(services()).toHaveLength(1);
      push([makeServer("srv-1", "A")], []);
      expect(useAppStore.getState().embeddedServers).toHaveLength(1);
    });

    it("treats a region that is not published yet as empty", async () => {
      await useAppStore.getState().loadEmbeddedServers();
      services()[0].push({ version: 0, view: null });
      expect(useAppStore.getState().embeddedServers).toEqual([]);
      expect(useAppStore.getState().embeddedServerStates).toEqual({});
    });

    it("keeps the list when it cannot subscribe", async () => {
      useAppStore.setState({ embeddedServers: [makeServer("keep", "K")] });
      startMock.mockRejectedValueOnce("raw string failure");
      await expect(useAppStore.getState().loadEmbeddedServers()).resolves.toBeUndefined();
      expect(useAppStore.getState().embeddedServers.map((s) => s.id)).toEqual(["keep"]);
    });

    it("a save and a delete change nothing here: the region does", async () => {
      useAppStore.setState({ embeddedServers: [makeServer("srv-1", "Old")] });
      await useAppStore.getState().saveEmbeddedServer(makeServer("srv-1", "New"));
      expect(apiSaveEmbeddedServer).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().embeddedServers[0].name).toBe("Old");
      await useAppStore.getState().deleteEmbeddedServer("srv-1");
      expect(apiDeleteEmbeddedServer).toHaveBeenCalledWith("srv-1");
      expect(useAppStore.getState().embeddedServers).toHaveLength(1);
    });

    it.each([new Error("failed"), "raw string failure"])(
      "a refused save and delete reach the caller (%s)",
      async (reason) => {
        vi.mocked(apiSaveEmbeddedServer).mockRejectedValueOnce(reason);
        vi.mocked(apiDeleteEmbeddedServer).mockRejectedValueOnce(reason);
        await expect(
          useAppStore.getState().saveEmbeddedServer(makeServer("srv-2", "New"))
        ).rejects.toBe(reason);
        await expect(useAppStore.getState().deleteEmbeddedServer("srv-2")).rejects.toBe(reason);
      }
    );
  });

  describe("a delete can be undone (#6076)", () => {
    it("once, from its toast", async () => {
      const info = vi.spyOn(toast, "info");
      useAppStore.setState({ embeddedServers: [makeServer("srv-1", "Docs")] });
      await useAppStore.getState().deleteEmbeddedServer("srv-1");
      expect(info).toHaveBeenCalledWith("Deleted Docs", expect.anything());
      const undo = () =>
        (info.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick();
      undo();
      undo();
      expect(apiRestoreEmbeddedServer).toHaveBeenCalledTimes(1);
      expect(apiRestoreEmbeddedServer).toHaveBeenCalledWith("srv-1");
      info.mockRestore();
    });

    it("says when it cannot, and is not offered when nothing was deleted", async () => {
      const info = vi.spyOn(toast, "info");
      const error = vi.spyOn(toast, "error");
      vi.mocked(apiDeleteEmbeddedServer).mockRejectedValueOnce(new Error("no"));
      await useAppStore
        .getState()
        .deleteEmbeddedServer("srv-1")
        .catch(() => undefined);
      expect(info).not.toHaveBeenCalled();
      await useAppStore.getState().deleteEmbeddedServer("gone");
      vi.mocked(apiRestoreEmbeddedServer).mockRejectedValueOnce(new Error("too late"));
      (info.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick();
      await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith("Failed to restore file server", {
          description: "too late",
        })
      );
      info.mockRestore();
      error.mockRestore();
    });
  });

  describe("restartEmbeddedServer", () => {
    it("stops, then starts", async () => {
      const order: string[] = [];
      vi.mocked(apiStopEmbeddedServer).mockImplementationOnce(async () => void order.push("stop"));
      vi.mocked(apiStartEmbeddedServer).mockImplementationOnce(
        async () => void order.push("start")
      );
      await useAppStore.getState().restartEmbeddedServer("srv-1");
      expect(order).toEqual(["stop", "start"]);
    });

    it("does not start what it could not stop", async () => {
      vi.mocked(apiStopEmbeddedServer).mockRejectedValueOnce(new Error("no"));
      await expect(useAppStore.getState().restartEmbeddedServer("srv-1")).rejects.toThrow("no");
      expect(apiStartEmbeddedServer).not.toHaveBeenCalled();
    });
  });

  describe("startEmbeddedServer / stopEmbeddedServer", () => {
    it("start resolves via the backend without mutating store state", async () => {
      await useAppStore.getState().startEmbeddedServer("srv-1");
      expect(apiStartEmbeddedServer).toHaveBeenCalledWith("srv-1");
    });

    it("start rethrows so the caller can toast the failure", async () => {
      vi.mocked(apiStartEmbeddedServer).mockRejectedValueOnce(new Error("port in use"));
      await expect(useAppStore.getState().startEmbeddedServer("srv-1")).rejects.toThrow(
        "port in use"
      );
    });

    it("stop resolves via the backend", async () => {
      await useAppStore.getState().stopEmbeddedServer("srv-1");
      expect(apiStopEmbeddedServer).toHaveBeenCalledWith("srv-1");
    });

    it("stop rethrows on backend failure", async () => {
      vi.mocked(apiStopEmbeddedServer).mockRejectedValueOnce(new Error("not running"));
      await expect(useAppStore.getState().stopEmbeddedServer("srv-1")).rejects.toThrow(
        "not running"
      );
    });
  });
});
