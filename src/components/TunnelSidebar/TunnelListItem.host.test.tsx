/**
 * Vantage host-badge tests for the tunnel list item (S3, #2155): every row shows
 * where the tunnel is hosted — "this computer" for desktop tunnels, the agent
 * name for agent-hosted ones.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { TunnelListItem } from "./TunnelListItem";
import { withTooltip } from "@/test/tooltip";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import type { SavedConnection } from "@/types/connection";

const noop = () => {};

const BASE: Omit<TunnelConfig, "host"> = {
  id: "tun-1",
  name: "My Tunnel",
  sshConnectionId: "ssh-1",
  autoStart: false,
  reconnectOnDisconnect: false,
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "example.com", remotePort: 80 },
  },
};

const STATE: TunnelState = {
  tunnelId: "tun-1",
  status: "connected",
  stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
};

let container: HTMLDivElement;
let root: Root;

function renderItem(tunnel: TunnelConfig): void {
  act(() => {
    root.render(
      withTooltip(
        <TunnelListItem
          tunnel={tunnel}
          state={STATE}
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

function badge(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="tunnel-host-tun-1"]');
}

setupAgentsRegion();

describe("TunnelListItem — vantage host badge (S3, #2155)", () => {
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

  it("reads 'this computer' for a desktop-hosted tunnel (default)", () => {
    renderItem({ ...BASE, host: { kind: "thisComputer" } });
    expect(badge()?.textContent).toContain("this computer");
    expect(badge()?.getAttribute("data-on-agent")).toBe("false");
  });

  it("reads 'this computer' when the host field is absent (legacy config)", () => {
    renderItem({ ...BASE } as TunnelConfig);
    expect(badge()?.textContent).toContain("this computer");
  });

  it("names the agent for an agent-hosted tunnel", () => {
    renderItem({ ...BASE, host: { kind: "agent", agentId: "agent-1" } });
    expect(badge()?.textContent).toContain("build-box");
    expect(badge()?.getAttribute("data-on-agent")).toBe("true");
  });
});
