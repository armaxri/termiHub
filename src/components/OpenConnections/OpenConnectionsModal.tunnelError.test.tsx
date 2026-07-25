/**
 * Tests for errored / stale tunnels in the Open Connections kill panel (#1240,
 * Stage S1 / GAP 3).
 *
 * The canonical kill panel must list an `error` tunnel (its leaked
 * `active_tunnels` entry is still holding resources) and offer a working
 * force-**Stop** that calls `stop_tunnel` (which, per #1238, also clears the
 * persisted error).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";

// jsdom lacks the observer/pointer-capture APIs Radix Tooltip touches.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  xServerStatus: vi.fn(() =>
    Promise.resolve({ state: "absent", platform: "linux", managed: false })
  ),
  xServerStop: vi.fn(() => Promise.resolve()),
}));

const getTunnelStatuses = vi.fn(() => Promise.resolve([] as TunnelState[]));
const stopTunnel = vi.fn((_id: string) => Promise.resolve());
vi.mock("@/services/tunnelApi", () => ({
  getTunnelStatuses: () => getTunnelStatuses(),
  stopTunnel: (id: string) => stopTunnel(id),
}));

import { OpenConnectionsModal } from "./OpenConnectionsModal";

function tunnelConfig(id: string, name: string): TunnelConfig {
  return {
    id,
    name,
    sshConnectionId: "ssh-1",
    tunnelType: {
      type: "local",
      config: {
        localHost: "127.0.0.1",
        localPort: 8080,
        remoteHost: "example.com",
        remotePort: 80,
      },
    },
    autoStart: false,
    reconnectOnDisconnect: false,
  };
}

function erroredState(id: string, error: string): TunnelState {
  return {
    tunnelId: id,
    status: "error",
    error,
    stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
  };
}

function tunnelRows(): Element[] {
  const section = Array.from(document.querySelectorAll(".oc-section__title")).find(
    (t) => t.textContent === "SSH Tunnels"
  );
  if (!section) return [];
  const sectionEl = section.closest("div")?.parentElement;
  return Array.from(sectionEl?.querySelectorAll(".oc-row") ?? []);
}

describe("OpenConnectionsModal — errored tunnels (#1240)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    getTunnelStatuses.mockClear();
    stopTunnel.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderModal() {
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
  }

  it("lists an errored tunnel so its leaked resources can be force-stopped", () => {
    useAppStore.setState({
      tunnels: [tunnelConfig("t1", "expose-web")],
      tunnelStates: { t1: erroredState("t1", "SSH session closed by peer") },
    });

    renderModal();

    const rows = tunnelRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("expose-web");
  });

  it("force-Stop on an errored tunnel invokes stop_tunnel", () => {
    useAppStore.setState({
      tunnels: [tunnelConfig("t1", "expose-web")],
      tunnelStates: { t1: erroredState("t1", "SSH session closed by peer") },
    });

    renderModal();

    const killBtn = tunnelRows()[0].querySelector<HTMLButtonElement>(".oc-row__kill");
    expect(killBtn).not.toBeNull();
    act(() => {
      killBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(stopTunnel).toHaveBeenCalledWith("t1");
  });
});
