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
    expect(seen).toEqual({ agents, connections, networkAddress: undefined });
    expect(listNetworkInterfaces).not.toHaveBeenCalled();
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
