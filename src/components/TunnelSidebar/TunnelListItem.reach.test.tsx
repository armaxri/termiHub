/**
 * Runtime reachability-note tests for the tunnel list item (#2199): a running
 * agent-hosted tunnel surfaces the agent's reported vantage — a loopback bind on
 * the agent warns (not reachable from this computer), a widened / SSH-server bind
 * reads plainly, and desktop tunnels show no note.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { TunnelListItem } from "./TunnelListItem";
import { NO_CONTEXT } from "@/test/serviceContext";
import type { ServiceContext } from "@/utils/serviceModel";
import { withTooltip } from "@/test/tooltip";
import type { ReachableFrom, TunnelConfig, TunnelState, TunnelStatus } from "@/types/tunnel";

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

const CONTEXT: ServiceContext = {
  ...NO_CONTEXT,
  agents: [{ id: "agent-1", name: "build-box", config: {} as never }],
};

let container: HTMLDivElement;
let root: Root;

function renderItem(tunnel: TunnelConfig, state: TunnelState): void {
  act(() => {
    root.render(
      withTooltip(
        <TunnelListItem
          tunnel={tunnel}
          state={state}
          context={CONTEXT}
          onStart={noop}
          onStop={noop}
          onReconnect={noop}
          onEdit={noop}
          onDuplicate={noop}
          onDelete={noop}
          onUsePort={vi.fn()}
        />
      )
    );
  });
}

function address(): string | null | undefined {
  return container.querySelector('[data-testid="tunnel-address-tun-1"]')?.textContent;
}

function rowTooltip(): string {
  const row = container.querySelector('[data-testid="tunnel-item-tun-1"]');
  return row?.getAttribute("aria-description") ?? "";
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

  it("says on which machine a loopback bind on the agent opens (#6028)", () => {
    renderItem(AGENT_TUNNEL, stateWith("agentOnly", "connected", "127.0.0.1:8080"));
    expect(address()).toBe("localhost:8080only on that machine");
    expect(rowTooltip()).toContain("Bound localhost:8080: reachable only on build-box");
  });

  it("puts a widened bind on the agent LAN in the tooltip", () => {
    renderItem(AGENT_TUNNEL, stateWith("agentLan"));
    expect(rowTooltip()).toContain("reachable on build-box's network");
  });

  it("says nothing about reach before the agent has reported it", () => {
    renderItem(AGENT_TUNNEL, stateWith(undefined));
    expect(rowTooltip()).not.toContain("reachable");
  });

  it("claims neither address nor reach once the tunnel is no longer running", () => {
    renderItem(AGENT_TUNNEL, stateWith("agentOnly", "disconnected"));
    expect(address()).toBeUndefined();
    expect(rowTooltip()).not.toContain("reachable");
  });
});
