import { describe, it, expect } from "vitest";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import { tunnelDeleteConfirmMessage, tunnelPortMapping } from "./tunnelSummary";

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
    expect(tunnelPortMapping(local)).toBe("127.0.0.1:8080 → db:5432");
    expect(tunnelPortMapping(remote)).toBe("0.0.0.0:9000 → 127.0.0.1:3000");
    expect(tunnelPortMapping(dynamic)).toBe("127.0.0.1:1080");
  });

  it("needs no confirmation to delete an idle, unchained tunnel", () => {
    expect(tunnelDeleteConfirmMessage([tunnel("a")], {}, "a")).toBeNull();
    expect(
      tunnelDeleteConfirmMessage([tunnel("a")], { a: state("a", "disconnected") }, "a")
    ).toBeNull();
  });

  it("does not claim that a tunnel runs whose agent is offline (#6028)", () => {
    const message = tunnelDeleteConfirmMessage(
      [tunnel("away")],
      { away: state("away", "notReachable") },
      "away"
    );
    expect(message).toContain("may still run on its agent, which is offline");
    expect(message).not.toContain("It is running");
    const waiting = { away: state("away", "waiting") };
    expect(tunnelDeleteConfirmMessage([tunnel("away")], waiting, "away")).toBeNull();
  });

  it("confirms an active tunnel, a chained parent and a companion", () => {
    const tunnels = [tunnel("parent"), tunnel("hop", { companionOf: "parent" }), tunnel("busy")];
    const states = { busy: state("busy", "reconnecting") };
    const says = (id: string) => tunnelDeleteConfirmMessage(tunnels, states, id);
    expect(says("busy")).toBe("It is running. Deleting stops it. You can undo it right after.");
    const open = (activeConnections: number) => {
      const busy = state("busy", "connected");
      const stats = { ...busy.stats, activeConnections };
      return tunnelDeleteConfirmMessage(tunnels, { busy: { ...busy, stats } }, "busy");
    };
    expect(open(1)).toContain("stops it and breaks 1 open connection.");
    expect(open(3)).toContain("stops it and breaks 3 open connections.");
    expect(says("parent")).toBe(
      'Its part on this computer, "hop", is deleted, too. You can undo it right after.'
    );
    expect(says("hop")).toContain("localhost no longer reaches the port");
    // Both reasons when both hold.
    const busyParent = { parent: state("parent", "connected") };
    expect(tunnelDeleteConfirmMessage(tunnels, busyParent, "parent")).toMatch(
      /^It is running\..* Its part on this computer/
    );
  });
});
