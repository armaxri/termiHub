import { describe, it, expect } from "vitest";

import type { TunnelConfig } from "@/types/tunnel";
import {
  bestSshViaForAgent,
  combinedPairStatus,
  companionIdFor,
  deriveCompanion,
  findCompanion,
  findParent,
  isCompanion,
  isCompanionRedundant,
  orderTunnelRows,
  pairStatusLabel,
} from "./tunnelChain";

/** An agent-hosted loopback `-L` parent — the case chaining remediates. */
function agentLocalParent(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    id: "tun-parent",
    name: "db",
    sshConnectionId: "conn-bastion",
    tunnelType: {
      type: "local",
      config: {
        localHost: "127.0.0.1",
        localPort: 5432,
        remoteHost: "db.internal",
        remotePort: 5432,
      },
    },
    host: { kind: "agent", agentId: "build-box" },
    autoStart: false,
    reconnectOnDisconnect: true,
    ...overrides,
  };
}

describe("deriveCompanion", () => {
  it("builds a desktop -L hop targeting the parent's loopback listen port", () => {
    const companion = deriveCompanion(agentLocalParent(), "conn-agent");

    // Runs on this computer, over the agent's own SSH connection.
    expect(companion.host).toEqual({ kind: "thisComputer" });
    expect(companion.sshConnectionId).toBe("conn-agent");
    // Always a local forward, listening on desktop loopback at the parent's port…
    expect(companion.tunnelType.type).toBe("local");
    if (companion.tunnelType.type === "local") {
      expect(companion.tunnelType.config.localHost).toBe("127.0.0.1");
      expect(companion.tunnelType.config.localPort).toBe(5432);
      // …forwarding to the parent's loopback listen socket on the agent.
      expect(companion.tunnelType.config.remoteHost).toBe("127.0.0.1");
      expect(companion.tunnelType.config.remotePort).toBe(5432);
    }
    // Linked to its parent and not independently auto-started.
    expect(companion.companionOf).toBe("tun-parent");
    expect(companion.autoStart).toBe(false);
    // Inherits the parent's reconnect preference for its own desktop→agent hop.
    expect(companion.reconnectOnDisconnect).toBe(true);
  });

  it("is a local hop even for a dynamic (-D) parent, using the SOCKS listen port", () => {
    const parent = agentLocalParent({
      tunnelType: { type: "dynamic", config: { localHost: "127.0.0.1", localPort: 1080 } },
    });
    const companion = deriveCompanion(parent, "conn-agent");
    expect(companion.tunnelType.type).toBe("local");
    if (companion.tunnelType.type === "local") {
      expect(companion.tunnelType.config.localPort).toBe(1080);
      expect(companion.tunnelType.config.remotePort).toBe(1080);
    }
  });

  it("derives a deterministic, per-parent id so chaining is idempotent", () => {
    const parent = agentLocalParent();
    expect(deriveCompanion(parent, "conn-agent").id).toBe(companionIdFor("tun-parent"));
    // Deriving twice yields the same id — never a duplicate companion.
    expect(deriveCompanion(parent, "conn-agent").id).toBe(deriveCompanion(parent, "conn-agent").id);
  });
});

describe("link walking", () => {
  const parent = agentLocalParent();
  const companion = deriveCompanion(parent, "conn-agent");
  const unrelated = agentLocalParent({ id: "tun-other", name: "other", companionOf: undefined });
  const tunnels = [parent, companion, unrelated];

  it("findCompanion resolves only the linked child", () => {
    expect(findCompanion(tunnels, "tun-parent")?.id).toBe(companion.id);
    expect(findCompanion(tunnels, "tun-other")).toBeUndefined();
    expect(findCompanion(tunnels, companion.id)).toBeUndefined();
  });

  it("findParent resolves a companion back to its parent", () => {
    expect(findParent(tunnels, companion)?.id).toBe("tun-parent");
    expect(findParent(tunnels, parent)).toBeUndefined();
  });

  it("isCompanion distinguishes the hop from a parent/plain tunnel", () => {
    expect(isCompanion(companion)).toBe(true);
    expect(isCompanion(parent)).toBe(false);
  });
});

describe("combinedPairStatus", () => {
  it("is 'none' when there is no companion", () => {
    expect(combinedPairStatus("connected", "disconnected", false)).toBe("none");
  });

  it("is 'connected' only when both sides are connected", () => {
    expect(combinedPairStatus("connected", "connected", true)).toBe("connected");
  });

  it("is 'connecting' when the parent is up and the companion is coming up", () => {
    expect(combinedPairStatus("connected", "connecting", true)).toBe("connecting");
    expect(combinedPairStatus("connected", "reconnecting", true)).toBe("connecting");
  });

  it("is 'degraded' when the parent is up but the companion is down", () => {
    expect(combinedPairStatus("connected", "error", true)).toBe("degraded");
    expect(combinedPairStatus("connected", "disconnected", true)).toBe("degraded");
  });

  it("is 'down' whenever the parent itself is not connected", () => {
    for (const parentStatus of ["disconnected", "connecting", "reconnecting", "error"] as const) {
      expect(combinedPairStatus(parentStatus, "connected", true)).toBe("down");
    }
  });
});

describe("pairStatusLabel", () => {
  it("maps each pair status to its 'Linked · …' label", () => {
    expect(pairStatusLabel("connected")).toBe("Linked · connected");
    expect(pairStatusLabel("connecting")).toBe("Linked · connecting");
    expect(pairStatusLabel("degraded")).toBe("Linked · degraded");
    expect(pairStatusLabel("down")).toBe("Linked · down");
  });

  it("has no label for an unchained ('none') parent", () => {
    expect(pairStatusLabel("none")).toBe("");
  });
});

describe("bestSshViaForAgent", () => {
  const candidates = [
    { id: "conn-bastion", host: "bastion.corp" },
    { id: "conn-agent", host: "build-box" },
  ];

  it("matches a saved SSH connection whose host equals the agent's host", () => {
    expect(bestSshViaForAgent(candidates, "build-box")).toBe("conn-agent");
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(bestSshViaForAgent(candidates, "  BUILD-BOX ")).toBe("conn-agent");
  });

  it("falls back to the first candidate when no host matches", () => {
    expect(bestSshViaForAgent(candidates, "other-host")).toBe("conn-bastion");
    expect(bestSshViaForAgent(candidates, undefined)).toBe("conn-bastion");
  });

  it("returns undefined when there are no candidates", () => {
    expect(bestSshViaForAgent([], "build-box")).toBeUndefined();
  });
});

describe("isCompanionRedundant", () => {
  it("is false for an agent-hosted loopback -L parent (the trap chaining fixes)", () => {
    expect(isCompanionRedundant(agentLocalParent())).toBe(false);
  });

  it("is true once the parent bind is widened away from loopback", () => {
    const widened = agentLocalParent({
      tunnelType: {
        type: "local",
        config: { localHost: "0.0.0.0", localPort: 5432, remoteHost: "db.internal", remotePort: 5432 },
      },
    });
    expect(isCompanionRedundant(widened)).toBe(true);
  });

  it("is true once the parent is re-hosted to this computer", () => {
    expect(isCompanionRedundant(agentLocalParent({ host: { kind: "thisComputer" } }))).toBe(true);
  });

  it("is true for a remote (-R) parent, which is never chained", () => {
    const remote = agentLocalParent({
      tunnelType: {
        type: "remote",
        config: { remoteHost: "0.0.0.0", remotePort: 8080, localHost: "127.0.0.1", localPort: 3000 },
      },
    });
    expect(isCompanionRedundant(remote)).toBe(true);
  });
});

describe("orderTunnelRows", () => {
  it("nests each companion directly beneath its parent, keeping other order", () => {
    const parent = agentLocalParent({ id: "p1" });
    const companion = deriveCompanion(parent, "conn-agent");
    const other = agentLocalParent({ id: "p2", companionOf: undefined });
    const rows = orderTunnelRows([parent, other, companion]);

    expect(rows.map((r) => r.tunnel.id)).toEqual(["p1", "p1-hop", "p2"]);
    expect(rows[1].parent?.id).toBe("p1");
    expect(rows[0].parent).toBeUndefined();
    expect(rows[2].parent).toBeUndefined();
  });

  it("keeps a companion whose parent is missing as a top-level row", () => {
    const orphan = deriveCompanion(agentLocalParent({ id: "gone" }), "conn-agent");
    const rows = orderTunnelRows([orphan]);
    expect(rows).toHaveLength(1);
    expect(rows[0].tunnel.id).toBe("gone-hop");
    expect(rows[0].parent).toBeUndefined();
  });
});
