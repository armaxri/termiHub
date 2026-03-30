import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

import {
  getTunnels,
  saveTunnel,
  deleteTunnel,
  getTunnelStatuses,
  startTunnel,
  stopTunnel,
} from "./tunnelApi";

describe("tunnelApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getTunnels", () => {
    it("invokes get_tunnels and returns configs", async () => {
      const tunnels = [
        {
          id: "t-1",
          name: "Dev DB",
          localPort: 5432,
          remoteHost: "db.internal",
          remotePort: 5432,
          sshConnectionId: "conn-1",
        },
      ];
      mockedInvoke.mockResolvedValue(tunnels);

      const result = await getTunnels();

      expect(mockedInvoke).toHaveBeenCalledWith("get_tunnels");
      expect(result).toEqual(tunnels);
    });

    it("returns empty array when no tunnels configured", async () => {
      mockedInvoke.mockResolvedValue([]);

      const result = await getTunnels();

      expect(result).toEqual([]);
    });
  });

  describe("saveTunnel", () => {
    it("invokes save_tunnel with config", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      const config = {
        id: "t-1",
        name: "Dev DB",
        localPort: 5432,
        remoteHost: "db.internal",
        remotePort: 5432,
        sshConnectionId: "conn-1",
      };

      await saveTunnel(config as never);

      expect(mockedInvoke).toHaveBeenCalledWith("save_tunnel", { config });
    });
  });

  describe("deleteTunnel", () => {
    it("invokes delete_tunnel with tunnelId", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await deleteTunnel("t-1");

      expect(mockedInvoke).toHaveBeenCalledWith("delete_tunnel", { tunnelId: "t-1" });
    });
  });

  describe("getTunnelStatuses", () => {
    it("invokes get_tunnel_statuses and returns states", async () => {
      const states = [
        { id: "t-1", status: "connected", localPort: 5432, error: null, stats: null },
      ];
      mockedInvoke.mockResolvedValue(states);

      const result = await getTunnelStatuses();

      expect(mockedInvoke).toHaveBeenCalledWith("get_tunnel_statuses");
      expect(result).toEqual(states);
    });
  });

  describe("startTunnel", () => {
    it("invokes start_tunnel with tunnelId", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await startTunnel("t-1");

      expect(mockedInvoke).toHaveBeenCalledWith("start_tunnel", { tunnelId: "t-1" });
    });
  });

  describe("stopTunnel", () => {
    it("invokes stop_tunnel with tunnelId", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await stopTunnel("t-1");

      expect(mockedInvoke).toHaveBeenCalledWith("stop_tunnel", { tunnelId: "t-1" });
    });
  });
});
