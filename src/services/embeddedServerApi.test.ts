import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

import {
  saveEmbeddedServer,
  deleteEmbeddedServer,
  startEmbeddedServer,
  stopEmbeddedServer,
  checkEmbeddedServers,
  createAndStartServer,
  listNetworkInterfaces,
  getEmbeddedServerActivity,
  clearEmbeddedServerActivity,
} from "./embeddedServerApi";

describe("embeddedServerApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("saveEmbeddedServer", () => {
    it("invokes save_embedded_server with config", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      const config = {
        id: "srv-1",
        name: "TFTP",
        type: "tftp",
        port: 69,
        bindAddress: "0.0.0.0",
        enabled: false,
      };

      await saveEmbeddedServer(config as never);

      expect(mockedInvoke).toHaveBeenCalledWith("save_embedded_server", { config });
    });
  });

  describe("deleteEmbeddedServer", () => {
    it("invokes delete_embedded_server with serverId", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await deleteEmbeddedServer("srv-1");

      expect(mockedInvoke).toHaveBeenCalledWith("delete_embedded_server", { serverId: "srv-1" });
    });
  });

  describe("startEmbeddedServer", () => {
    it("invokes start_embedded_server with serverId", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await startEmbeddedServer("srv-1");

      expect(mockedInvoke).toHaveBeenCalledWith("start_embedded_server", { serverId: "srv-1" });
    });
  });

  describe("stopEmbeddedServer", () => {
    it("invokes stop_embedded_server with serverId", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await stopEmbeddedServer("srv-1");

      expect(mockedInvoke).toHaveBeenCalledWith("stop_embedded_server", { serverId: "srv-1" });
    });
  });

  describe("checkEmbeddedServers", () => {
    it("invokes check_embedded_servers", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      await checkEmbeddedServers();
      expect(mockedInvoke).toHaveBeenCalledWith("check_embedded_servers");
    });
  });

  describe("createAndStartServer", () => {
    it("invokes create_and_start_server and returns new server ID", async () => {
      mockedInvoke.mockResolvedValue("srv-new");
      const config = {
        id: "srv-new",
        name: "FTP",
        type: "ftp",
        port: 21,
        bindAddress: "127.0.0.1",
        enabled: true,
      };

      const result = await createAndStartServer(config as never);

      expect(mockedInvoke).toHaveBeenCalledWith("create_and_start_server", { config });
      expect(result).toBe("srv-new");
    });
  });

  describe("listNetworkInterfaces", () => {
    it("invokes list_network_interfaces and returns interfaces", async () => {
      const ifaces = [
        { name: "Loopback", address: "127.0.0.1" },
        { name: "eth0", address: "192.168.1.100" },
        { name: "All interfaces", address: "0.0.0.0" },
      ];
      mockedInvoke.mockResolvedValue(ifaces);

      const result = await listNetworkInterfaces();

      expect(mockedInvoke).toHaveBeenCalledWith("list_network_interfaces");
      expect(result).toEqual(ifaces);
    });

    it("always returns at least loopback and all-interfaces", async () => {
      const ifaces = [
        { name: "Loopback", addr: "127.0.0.1" },
        { name: "All interfaces", addr: "0.0.0.0" },
      ];
      mockedInvoke.mockResolvedValue(ifaces);

      const result = await listNetworkInterfaces();

      expect(result.some((i) => i.addr === "127.0.0.1")).toBe(true);
      expect(result.some((i) => i.addr === "0.0.0.0")).toBe(true);
    });
  });

  describe("access log (PROD-034/036)", () => {
    it("reads activity incrementally from a cursor", async () => {
      mockedInvoke.mockResolvedValue(null);
      const result = await getEmbeddedServerActivity("srv-1", 42);
      expect(mockedInvoke).toHaveBeenCalledWith("get_embedded_server_activity", {
        serverId: "srv-1",
        sinceSeq: 42,
      });
      expect(result).toBeNull();
    });

    it("reads the whole log when no cursor is given", async () => {
      mockedInvoke.mockResolvedValue(null);
      await getEmbeddedServerActivity("srv-1");
      expect(mockedInvoke).toHaveBeenCalledWith("get_embedded_server_activity", {
        serverId: "srv-1",
        sinceSeq: null,
      });
    });

    it("clears the log", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      await clearEmbeddedServerActivity("srv-1");
      expect(mockedInvoke).toHaveBeenCalledWith("clear_embedded_server_activity", {
        serverId: "srv-1",
      });
    });
  });
});
