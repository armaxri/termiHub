import { describe, it, expect } from "vitest";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import { tunnelDeleteConfirmMessage, tunnelPortMapping, tunnelTypeFlag } from "./tunnelSummary";

function tunnel(id: string, extra: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    id,
    name: id,
    sshConnectionId: "conn-1",
    tunnelType: {
      type: "local",
      config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "db", remotePort: 5432 },
    },
    autoStart: false,
    reconnectOnDisconnect: false,
    ...extra,
  };
}

function state(id: string, status: TunnelState["status"]): TunnelState {
  return {
    tunnelId: id,
    status,
    stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
  };
}

describe("tunnelSummary", () => {
  it("describes each tunnel type by flag and mapping", () => {
    const local = tunnel("l");
    const remote = tunnel("r", {
      tunnelType: {
        type: "remote",
        config: {
          remoteHost: "0.0.0.0",
          remotePort: 9000,
          localHost: "127.0.0.1",
          localPort: 3000,
        },
      },
    });
    const dynamic = tunnel("d", {
      tunnelType: { type: "dynamic", config: { localHost: "127.0.0.1", localPort: 1080 } },
    });
    expect([tunnelTypeFlag(local), tunnelPortMapping(local)]).toEqual([
      "-L",
      "127.0.0.1:8080 → db:5432",
    ]);
    expect([tunnelTypeFlag(remote), tunnelPortMapping(remote)]).toEqual([
      "-R",
      "0.0.0.0:9000 → 127.0.0.1:3000",
    ]);
    expect([tunnelTypeFlag(dynamic), tunnelPortMapping(dynamic)]).toEqual(["-D", "127.0.0.1:1080"]);
  });

  it("needs no confirmation to delete an idle, unchained tunnel", () => {
    expect(tunnelDeleteConfirmMessage([tunnel("a")], {}, "a")).toBeNull();
    expect(
      tunnelDeleteConfirmMessage([tunnel("a")], { a: state("a", "disconnected") }, "a")
    ).toBeNull();
  });

  it("confirms an active tunnel, a chained parent and a companion", () => {
    const tunnels = [tunnel("parent"), tunnel("hop", { companionOf: "parent" }), tunnel("busy")];
    const states = { busy: state("busy", "reconnecting") };
    expect(tunnelDeleteConfirmMessage(tunnels, states, "busy")).toContain("currently active");
    expect(tunnelDeleteConfirmMessage(tunnels, states, "parent")).toContain('linked hop "hop"');
    expect(tunnelDeleteConfirmMessage(tunnels, states, "hop")).toContain("removes the hop");
  });
});
