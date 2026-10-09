import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

import { saveTunnel, deleteTunnel, startTunnel, stopTunnel } from "./tunnelApi";

describe("tunnelApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
