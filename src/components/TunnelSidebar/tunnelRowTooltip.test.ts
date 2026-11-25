import { describe, it, expect } from "vitest";
import { tunnelRowTooltip } from "./tunnelRowTooltip";
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
  it("lists the forwarding, what it does (#6027), the SSH connection and the host", () => {
    expect(tunnelRowTooltip(LOCAL, { sshLabel: "bastion", host: LOCAL_HOST })).toEqual([
      "Local (ssh -L) · 127.0.0.1:5432 → db:5432",
      "Use something on the SSH server's side as if it ran here.",
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
    expect(lines[1]).toBe(
      "Use something on the SSH server's side as if it ran on agent build-box."
    );
  });

  it("adds the traffic, and a reachability note with its bound address", () => {
    const lines = tunnelRowTooltip(LOCAL, {
      sshLabel: "bastion",
      host: LOCAL_HOST,
      stats: { bytesSent: 2048, bytesReceived: 0, activeConnections: 1, totalConnections: 4 },
      upRate: 1024,
      reach: "reachable on build-box's network",
      boundAddress: "0.0.0.0:5432",
    });
    expect(lines.slice(4)).toEqual([
      "↑ 2.0 KB (1 KB/s) · ↓ 0 B · 1 / 4 connections",
      "Bound 0.0.0.0:5432: reachable on build-box's network",
    ]);
  });

  it("names and explains each tunnel type", () => {
    const socks = tunnelRowTooltip(
      {
        ...LOCAL,
        tunnelType: { type: "dynamic", config: { localHost: "127.0.0.1", localPort: 1080 } },
      },
      { sshLabel: "bastion", host: LOCAL_HOST }
    );
    expect(socks.slice(0, 2)).toEqual([
      "Dynamic (ssh -D) · 127.0.0.1:1080",
      "Use the SSH server as a proxy for many destinations.",
    ]);
  });
});
