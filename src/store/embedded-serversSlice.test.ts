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

import type { EmbeddedServerConfig, ServerState } from "@/types/embeddedServer";

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
  listEmbeddedServers: vi.fn(() => Promise.resolve([])),
  saveEmbeddedServer: vi.fn(() => Promise.resolve()),
  deleteEmbeddedServer: vi.fn(() => Promise.resolve()),
  startEmbeddedServer: vi.fn(() => Promise.resolve()),
  stopEmbeddedServer: vi.fn(() => Promise.resolve()),
  getEmbeddedServerStates: vi.fn(() => Promise.resolve([])),
  createAndStartServer: vi.fn(() => Promise.resolve("srv-new")),
  listNetworkInterfaces: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "./appStore";
import {
  listEmbeddedServers as apiListEmbeddedServers,
  saveEmbeddedServer as apiSaveEmbeddedServer,
  startEmbeddedServer as apiStartEmbeddedServer,
  stopEmbeddedServer as apiStopEmbeddedServer,
  getEmbeddedServerStates as apiGetEmbeddedServerStates,
  createAndStartServer as apiCreateAndStartServer,
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("loadEmbeddedServers", () => {
    it("populates the config list and keys the runtime states by serverId", async () => {
      vi.mocked(apiListEmbeddedServers).mockResolvedValueOnce([
        makeServer("srv-1", "A"),
        makeServer("srv-2", "B"),
      ]);
      vi.mocked(apiGetEmbeddedServerStates).mockResolvedValueOnce([
        runningState("srv-1"),
        runningState("srv-2"),
      ]);

      await useAppStore.getState().loadEmbeddedServers();

      expect(useAppStore.getState().embeddedServers.map((s) => s.id)).toEqual(["srv-1", "srv-2"]);
      expect(useAppStore.getState().embeddedServerStates["srv-1"].status).toBe("running");
      expect(useAppStore.getState().embeddedServerStates["srv-2"].status).toBe("running");
    });

    it("swallows a backend failure and leaves state untouched (read-only load)", async () => {
      useAppStore.setState({ embeddedServers: [makeServer("keep", "K")] });
      vi.mocked(apiListEmbeddedServers).mockRejectedValueOnce(new Error("boom"));

      await expect(useAppStore.getState().loadEmbeddedServers()).resolves.toBeUndefined();

      // The pre-existing state is not clobbered on failure.
      expect(useAppStore.getState().embeddedServers.map((s) => s.id)).toEqual(["keep"]);
    });
  });

  describe("refreshEmbeddedServerStates", () => {
    it("refreshes only the runtime states without touching the config list", async () => {
      useAppStore.setState({ embeddedServers: [makeServer("srv-1", "A")] });
      vi.mocked(apiGetEmbeddedServerStates).mockResolvedValueOnce([runningState("srv-1")]);

      await useAppStore.getState().refreshEmbeddedServerStates();

      expect(useAppStore.getState().embeddedServerStates["srv-1"].status).toBe("running");
      // Config list untouched — refresh does not reload it.
      expect(apiListEmbeddedServers).not.toHaveBeenCalled();
      expect(useAppStore.getState().embeddedServers.map((s) => s.id)).toEqual(["srv-1"]);
    });

    it("swallows a states-fetch failure and leaves the prior states in place", async () => {
      useAppStore.setState({ embeddedServerStates: { "srv-1": runningState("srv-1") } });
      vi.mocked(apiGetEmbeddedServerStates).mockRejectedValueOnce(new Error("no states"));

      await expect(useAppStore.getState().refreshEmbeddedServerStates()).resolves.toBeUndefined();

      expect(useAppStore.getState().embeddedServerStates["srv-1"].status).toBe("running");
    });
  });

  describe("saveEmbeddedServer", () => {
    it("appends a brand-new server to the list", async () => {
      await useAppStore.getState().saveEmbeddedServer(makeServer("srv-1", "New"));

      expect(apiSaveEmbeddedServer).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().embeddedServers.map((s) => s.id)).toEqual(["srv-1"]);
    });

    it("replaces an existing server in place rather than duplicating it", async () => {
      useAppStore.setState({ embeddedServers: [makeServer("srv-1", "Old")] });

      await useAppStore
        .getState()
        .saveEmbeddedServer({ ...makeServer("srv-1", "Renamed"), port: 9090 });

      const servers = useAppStore.getState().embeddedServers;
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe("Renamed");
      expect(servers[0].port).toBe(9090);
    });

    it("updates only the matching server and passes every sibling through untouched", async () => {
      // Two existing servers: saving an edit to srv-1 must replace srv-1 in place
      // while srv-2 flows through the `.map` untouched (the sibling-passthrough
      // branch of the replace path — line 87). A prior single-item test could not
      // exercise the "keep this other one" arm.
      const srv2 = makeServer("srv-2", "Keep");
      useAppStore.setState({ embeddedServers: [makeServer("srv-1", "Old"), srv2] });

      await useAppStore
        .getState()
        .saveEmbeddedServer({ ...makeServer("srv-1", "Renamed"), port: 9191 });

      const servers = useAppStore.getState().embeddedServers;
      expect(servers.map((s) => s.id)).toEqual(["srv-1", "srv-2"]);
      const updated = servers.find((s) => s.id === "srv-1");
      expect(updated?.name).toBe("Renamed");
      expect(updated?.port).toBe(9191);
      // The untouched sibling is the exact same object reference (passed through).
      expect(servers.find((s) => s.id === "srv-2")).toBe(srv2);
    });

    it("rethrows and does not mutate the list when the backend save fails", async () => {
      useAppStore.setState({ embeddedServers: [makeServer("srv-1", "Old")] });
      vi.mocked(apiSaveEmbeddedServer).mockRejectedValueOnce(new Error("save failed"));

      await expect(
        useAppStore.getState().saveEmbeddedServer(makeServer("srv-2", "New"))
      ).rejects.toThrow("save failed");

      // srv-2 was never added because the backend call rejected before the set().
      expect(useAppStore.getState().embeddedServers.map((s) => s.id)).toEqual(["srv-1"]);
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

  describe("updateEmbeddedServerState", () => {
    it("merges a single pushed state under its serverId, preserving others", () => {
      useAppStore.setState({ embeddedServerStates: { "srv-1": runningState("srv-1") } });

      const stopped: ServerState = { ...runningState("srv-2"), status: "stopped" };
      useAppStore.getState().updateEmbeddedServerState(stopped);

      expect(useAppStore.getState().embeddedServerStates["srv-1"].status).toBe("running");
      expect(useAppStore.getState().embeddedServerStates["srv-2"].status).toBe("stopped");
    });
  });

  // `loadEmbeddedServers` / `saveEmbeddedServer` stringify the rejection via
  // `err instanceof Error ? err.message : String(err)`. The Error side is covered
  // above; these pin the non-Error (raw string) side of that guard.
  describe("non-Error rejections stringify via the String(err) branch", () => {
    it("loadEmbeddedServers swallows a non-Error rejection", async () => {
      useAppStore.setState({ embeddedServers: [makeServer("keep", "K")] });
      vi.mocked(apiListEmbeddedServers).mockRejectedValueOnce("raw string failure");

      await expect(useAppStore.getState().loadEmbeddedServers()).resolves.toBeUndefined();
      expect(useAppStore.getState().embeddedServers.map((s) => s.id)).toEqual(["keep"]);
    });

    it("saveEmbeddedServer rethrows a non-Error rejection", async () => {
      vi.mocked(apiSaveEmbeddedServer).mockRejectedValueOnce("raw string failure");

      await expect(
        useAppStore.getState().saveEmbeddedServer(makeServer("srv-1", "New"))
      ).rejects.toBe("raw string failure");
    });
  });

  describe("quickShareServer", () => {
    it("creates+starts an http share with directory listing on and refreshes the list", async () => {
      vi.mocked(apiCreateAndStartServer).mockResolvedValueOnce("srv-http");
      vi.mocked(apiListEmbeddedServers).mockResolvedValueOnce([makeServer("srv-http", "Quick")]);
      vi.mocked(apiGetEmbeddedServerStates).mockResolvedValueOnce([runningState("srv-http")]);

      const id = await useAppStore.getState().quickShareServer("/srv/www", "http");

      expect(id).toBe("srv-http");
      const config = vi.mocked(apiCreateAndStartServer).mock.calls[0][0];
      expect(config.serverType).toBe("http");
      expect(config.port).toBe(8080);
      expect(config.rootDirectory).toBe("/srv/www");
      expect(config.directoryListing).toBe(true);
      // The freshly created share was loaded back into the list.
      expect(useAppStore.getState().embeddedServers.map((s) => s.id)).toEqual(["srv-http"]);
    });

    it("leaves directoryListing undefined for a non-http (tftp) share", async () => {
      vi.mocked(apiCreateAndStartServer).mockResolvedValueOnce("srv-tftp");

      await useAppStore.getState().quickShareServer("/boot", "tftp");

      const config = vi.mocked(apiCreateAndStartServer).mock.calls[0][0];
      expect(config.serverType).toBe("tftp");
      expect(config.port).toBe(6969);
      expect(config.directoryListing).toBeUndefined();
    });
  });
});
