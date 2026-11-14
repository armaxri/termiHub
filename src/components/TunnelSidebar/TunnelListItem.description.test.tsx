/**
 * A tunnel row shows the user's description muted under the name (#5770),
 * and nothing more when there is none.
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

function row(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-testid="tunnel-item-tun-1"]')!;
}

setupAgentsRegion();

describe("TunnelListItem — description (#5770)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedAgentsRegion({ remoteAgents: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the description muted under the name", () => {
    renderItem({ ...BASE, description: "Reaches the dev DB" } as TunnelConfig);
    const desc = container.querySelector('[data-testid="tunnel-description-tun-1"]');
    expect(desc?.textContent).toBe("Reaches the dev DB");
  });

  it("shows no description line without one", () => {
    renderItem({ ...BASE } as TunnelConfig);
    expect(container.querySelector('[data-testid="tunnel-description-tun-1"]')).toBeNull();
    expect(row().textContent).toBe("My Tunnel");
  });
});
