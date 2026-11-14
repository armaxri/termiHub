import { describe, it, expect } from "vitest";
import { tunnelRowTooltip, tunnelTypeLabel } from "./tunnelRowTooltip";
import type { TunnelConfig } from "@/types/tunnel";

const LOCAL: TunnelConfig = {
  id: "t1",
  name: "Prod DB",
  sshConnectionId: "ssh-1",
  autoStart: false,
  reconnectOnDisconnect: false,
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
  },
};

const LOCAL_HOST = { label: "this computer", onAgent: false };

describe("tunnelRowTooltip (#5770)", () => {
  it("lists the forwarding, the SSH connection and the host", () => {
    expect(tunnelRowTooltip(LOCAL, { sshLabel: "bastion", host: LOCAL_HOST })).toEqual([
      "Local · 127.0.0.1:5432 → db:5432",
      "Via bastion",
      "Hosted on this computer",
    ]);
  });

  it("names the agent that hosts the tunnel", () => {
    const lines = tunnelRowTooltip(LOCAL, {
      sshLabel: "bastion",
      host: { label: "build-box", onAgent: true },
    });
    expect(lines).toContain("Hosted on agent build-box");
  });

  it("adds the traffic, a reachability note with its bound address and a pair label", () => {
    const lines = tunnelRowTooltip(LOCAL, {
      sshLabel: "bastion",
      host: LOCAL_HOST,
      stats: { bytesSent: 2048, bytesReceived: 0, activeConnections: 1, totalConnections: 4 },
      upRate: 1024,
      reach: "reachable on build-box's network",
      boundAddress: "0.0.0.0:5432",
      pair: "Linked · connected",
    });
    expect(lines.slice(3)).toEqual([
      "↑ 2.0 KB (1 KB/s) · ↓ 0 B · 1 / 4 connections",
      "Bound 0.0.0.0:5432: reachable on build-box's network",
      "Linked · connected",
    ]);
  });

  it("labels each tunnel type", () => {
    expect(
      tunnelTypeLabel({
        ...LOCAL,
        tunnelType: { type: "dynamic", config: LOCAL.tunnelType.config },
      } as TunnelConfig)
    ).toBe("Dynamic");
  });
});
