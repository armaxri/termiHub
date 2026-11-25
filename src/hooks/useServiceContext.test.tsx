import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

const { listNetworkInterfaces, agents, connections } = vi.hoisted(() => ({
  listNetworkInterfaces: vi.fn(),
  agents: [{ id: "a" }],
  connections: [{ id: "c" }],
}));
vi.mock("@/services/embeddedServerApi", () => ({ listNetworkInterfaces }));
vi.mock("@/store/useProjectedAgents", () => ({
  useProjectedAgents: () => ({ remoteAgents: agents }),
}));
vi.mock("@/store/useProjectedConnections", () => ({
  useProjectedConnections: () => ({ connections }),
}));

import { useAppStore } from "@/store/appStore";
import type { ServiceContext } from "@/utils/serviceModel";
import { useServiceContext } from "./useServiceContext";

let seen: ServiceContext;
function Probe({ needsNetwork }: { needsNetwork: boolean }) {
  seen = useServiceContext(needsNetwork);
  return null;
}

let container: HTMLDivElement;
let root: Root;

async function render(needsNetwork: boolean) {
  await act(async () => root.render(<Probe needsNetwork={needsNetwork} />));
}

describe("useServiceContext (#6028)", () => {
  beforeEach(() => {
    listNetworkInterfaces.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("hands on the agents and connections, and asks for nothing else", async () => {
    await render(false);
    expect(seen).toEqual({
      agents,
      agentsKnown: true,
      connections,
      networkAddress: undefined,
      usedPorts: new Set(),
    });
    expect(listNetworkInterfaces).not.toHaveBeenCalled();
  });

  it("knows the ports of the services on this computer", async () => {
    const edge = { kind: "agent", agentId: "edge" };
    const listening = (type: string, localPort: number, host?: unknown) => ({
      tunnelType: { type, config: { localPort } },
      host,
    });
    useAppStore.setState({
      tunnels: [
        listening("local", 15432),
        listening("dynamic", 1080),
        // Listens on the SSH server.
        listening("remote", 3000),
        listening("local", 5000, edge),
      ] as never,
      embeddedServers: [{ port: 8080 }, { port: 9000, host: edge }] as never,
    });
    await render(false);
    expect(seen.usedPorts).toEqual(new Set([15432, 1080, 8080]));
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("reads this computer's address, not loopback and not all interfaces", async () => {
    listNetworkInterfaces.mockResolvedValue([
      { name: "Loopback", addr: "127.0.0.1" },
      { name: "All", addr: "0.0.0.0" },
      { name: "en0", addr: "192.168.1.20" },
    ]);
    await render(true);
    expect(seen.networkAddress).toBe("192.168.1.20");
  });

  it("asks again while there is none, and when this computer gets online (T-006)", async () => {
    vi.useFakeTimers();
    try {
      listNetworkInterfaces.mockResolvedValue([]);
      await render(true);
      expect(listNetworkInterfaces).toHaveBeenCalledTimes(1);
      await act(async () => void vi.advanceTimersByTime(10_000));
      expect(listNetworkInterfaces).toHaveBeenCalledTimes(2);
      listNetworkInterfaces.mockResolvedValue([{ name: "en0", addr: "192.168.1.20" }]);
      await act(async () => void window.dispatchEvent(new Event("online")));
      expect(seen.networkAddress).toBe("192.168.1.20");
      // It is known: nothing to poll for.
      listNetworkInterfaces.mockClear();
      await act(async () => void vi.advanceTimersByTime(60_000));
      expect(listNetworkInterfaces).not.toHaveBeenCalled();
      // Another network.
      listNetworkInterfaces.mockResolvedValue([{ name: "en0", addr: "10.0.0.9" }]);
      await act(async () => void window.dispatchEvent(new Event("focus")));
      expect(seen.networkAddress).toBe("10.0.0.9");
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes without it when there is none or it cannot be read", async () => {
    listNetworkInterfaces.mockResolvedValueOnce([{ name: "Loopback", addr: "127.0.0.1" }]);
    await render(true);
    expect(seen.networkAddress).toBeUndefined();
    listNetworkInterfaces.mockRejectedValueOnce(new Error("no"));
    await render(false);
    await render(true);
    expect(seen.networkAddress).toBeUndefined();
  });
});
