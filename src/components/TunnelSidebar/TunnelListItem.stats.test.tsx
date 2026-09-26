/**
 * Stats-line tests for the tunnel list item (PROD-037): an active tunnel surfaces
 * both the live active-connection count and the cumulative total-connection count
 * the stats already carry. Display-only — the counts flow straight from
 * `state.stats`; nothing here changes how they are collected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { TunnelListItem } from "./TunnelListItem";
import { withTooltip } from "@/test/tooltip";
import type { TunnelConfig, TunnelState, TunnelStats, TunnelStatus } from "@/types/tunnel";
import type { SavedConnection } from "@/types/connection";

const noop = () => {};

const TUNNEL: TunnelConfig = {
  id: "tun-1",
  name: "My Tunnel",
  sshConnectionId: "ssh-1",
  autoStart: false,
  reconnectOnDisconnect: false,
  host: { kind: "thisComputer" },
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "example.com", remotePort: 80 },
  },
};

function stateWith(stats: TunnelStats, status: TunnelStatus = "connected"): TunnelState {
  return { tunnelId: "tun-1", status, stats };
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

function connStat(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="tunnel-conn-stat-tun-1"]');
}

setupAgentsRegion();

describe("TunnelListItem — connection stats (PROD-037)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the active and total connection counts for an active tunnel", () => {
    renderItem(
      TUNNEL,
      stateWith({ bytesSent: 0, bytesReceived: 0, activeConnections: 2, totalConnections: 17 })
    );
    const stat = connStat();
    expect(stat).not.toBeNull();
    expect(stat?.textContent).toContain("2 / 17 conn");
  });

  it("still renders when no connections have been seen yet", () => {
    renderItem(
      TUNNEL,
      stateWith({ bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 })
    );
    expect(connStat()?.textContent).toContain("0 / 0 conn");
  });

  it("shows no stats line while the tunnel is inactive", () => {
    renderItem(
      TUNNEL,
      stateWith(
        { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
        "disconnected"
      )
    );
    expect(connStat()).toBeNull();
  });
});

describe("TunnelListItem — live rate (PROD-038)", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const stats = (bytesSent: number, bytesReceived: number): TunnelStats => ({
    bytesSent,
    bytesReceived,
    activeConnections: 1,
    totalConnections: 1,
  });
  const up = () => container.querySelector('[data-testid="tunnel-up-stat-tun-1"]')?.textContent;
  const down = () => container.querySelector('[data-testid="tunnel-down-stat-tun-1"]')?.textContent;

  it("shows a smoothed KB/s rate next to each running total", () => {
    renderItem(TUNNEL, stateWith(stats(0, 0)));
    // Only one sample so far → totals only, no rate yet.
    expect(up()).not.toContain("/s");

    renderItem(TUNNEL, stateWith(stats(10 * 1024, 20 * 1024)));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(up()).toContain("10 KB/s");
    expect(down()).toContain("20 KB/s");
  });

  it("drops the rate once the counters stop moving", () => {
    renderItem(TUNNEL, stateWith(stats(0, 0)));
    renderItem(TUNNEL, stateWith(stats(10 * 1024, 0)));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(up()).toContain("KB/s");
    // A long idle stretch with no new bytes decays the rate to nothing.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(up()).not.toContain("/s");
  });

  it("shows no rate while the tunnel is not connected", () => {
    renderItem(TUNNEL, stateWith(stats(0, 0), "reconnecting"));
    renderItem(TUNNEL, stateWith(stats(50 * 1024, 50 * 1024), "reconnecting"));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(up()).not.toContain("/s");
    expect(down()).not.toContain("/s");
  });
});
