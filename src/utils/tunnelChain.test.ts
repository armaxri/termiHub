import { describe, it, expect } from "vitest";

import type { TunnelConfig } from "@/types/tunnel";
import {
  combinedPairStatus,
  companionIdFor,
  deriveCompanion,
  findCompanion,
  findParent,
  isCompanion,
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
