/**
 * Vantage host tests for the tunnel list item (S3, #2155): every row says
 * where the tunnel is hosted — "this computer" for desktop tunnels, the agent
 * name for agent-hosted ones. Since #5770 this is in the row's tooltip (its
 * accessible description), not on the row.
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
import type { TunnelConfig, TunnelState } from "@/types/tunnel";

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

const CONTEXT: ServiceContext = {
  ...NO_CONTEXT,
  agents: [{ id: "agent-1", name: "build-box", config: {} as never }],
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

function row(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-testid="tunnel-item-tun-1"]')!;
}

function rowTooltip(): string {
  return row().getAttribute("aria-description") ?? "";
}

setupAgentsRegion();

describe("TunnelListItem — where it runs, on the row and in the tooltip (#2155, #6028)", () => {
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
    expect(rowTooltip()).toContain("Runs on this computer");
    expect(container.querySelector('[data-testid^="tunnel-machine"]')).toBeNull();
  });

  it("reads 'this computer' when the host field is absent (legacy config)", () => {
    renderItem({ ...BASE } as TunnelConfig);
    expect(rowTooltip()).toContain("Runs on this computer");
  });

  it("names the agent for an agent-hosted tunnel", () => {
    renderItem({ ...BASE, host: { kind: "agent", agentId: "agent-1" } });
    expect(rowTooltip()).toContain("Runs on agent build-box");
    expect(container.querySelector('[data-testid^="tunnel-machine"]')?.textContent).toBe(
      "build-box"
    );
  });
});
