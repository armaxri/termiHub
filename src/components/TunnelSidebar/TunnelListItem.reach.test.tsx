/**
 * Runtime reachability-note tests for the tunnel list item (#2199): a running
 * agent-hosted tunnel surfaces the agent's reported vantage — a loopback bind on
 * the agent warns (not reachable from this computer), a widened / SSH-server bind
 * reads plainly, and desktop tunnels show no note.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { TunnelListItem } from "./TunnelListItem";
import { withTooltip } from "@/test/tooltip";
import type { ReachableFrom, TunnelConfig, TunnelState, TunnelStatus } from "@/types/tunnel";
import type { SavedConnection } from "@/types/connection";

const noop = () => {};

const AGENT_TUNNEL: TunnelConfig = {
  id: "tun-1",
  name: "My Tunnel",
  sshConnectionId: "ssh-1",
  autoStart: false,
  reconnectOnDisconnect: false,
  host: { kind: "agent", agentId: "agent-1" },
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "example.com", remotePort: 80 },
  },
};

function stateWith(
  reachableFrom: ReachableFrom | undefined,
  status: TunnelStatus = "connected",
  boundAddress?: string
): TunnelState {
  return {
    tunnelId: "tun-1",
    status,
    stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
    reachableFrom,
    boundAddress,
  };
}

let container: HTMLDivElement;
let root: Root;

function renderItem(tunnel: TunnelConfig, state: TunnelState): void {
  act(() => {
    root.render(
      withTooltip(
        <TunnelListItem
          tunnel={tunnel}
          state={state}
          connections={[] as SavedConnection[]}
          onStart={noop}
          onStop={noop}
          onReconnect={noop}
          onEdit={noop}
          onDuplicate={noop}
          onDelete={noop}
        />
      )
    );
  });
}

function reach(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="tunnel-reach-tun-1"]');
}

setupAgentsRegion();

describe("TunnelListItem — reported reachability note (#2199)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedAgentsRegion({ remoteAgents: [{ id: "agent-1", name: "build-box" } as any] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("warns for a loopback bind on the agent (agentOnly)", () => {
    renderItem(AGENT_TUNNEL, stateWith("agentOnly", "connected", "127.0.0.1:8080"));
    expect(reach()?.textContent).toContain("reachable only on build-box");
    expect(reach()?.getAttribute("data-warn")).toBe("true");
    // The bound address the agent reported is available on hover.
    expect(reach()?.getAttribute("title")).toContain("127.0.0.1:8080");
  });

  it("reads plainly for a widened bind on the agent LAN", () => {
    renderItem(AGENT_TUNNEL, stateWith("agentLan"));
    expect(reach()?.textContent).toContain("reachable on build-box's network");
    expect(reach()?.getAttribute("data-warn")).toBe("false");
  });

  it("shows no note before the agent has reported reachability", () => {
    renderItem(AGENT_TUNNEL, stateWith(undefined));
    expect(reach()).toBeNull();
  });

  it("shows no note once the tunnel is no longer active", () => {
    renderItem(AGENT_TUNNEL, stateWith("agentOnly", "disconnected"));
    expect(reach()).toBeNull();
  });
});
