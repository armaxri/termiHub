/**
 * Tests for the "SSH Tunnels" section of the Open Connections panel (#1141,
 * GAP 9): the tunnel list must be driven by the store's live `tunnelStates`
 * (the single source of truth) rather than a one-shot `getTunnelStatuses`
 * snapshot fetched only when the modal opens. This keeps the panel in sync with
 * the sidebar and reflects store updates without re-opening the modal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";

// jsdom lacks the observer/pointer-capture APIs Radix Tooltip touches when it
// mounts its trigger; shim them so tooltip-wrapped controls render.
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

// The one-shot fetch, if the component still used it, would return an EMPTY
// list — so any tunnel rows that render must come from the store's live map.
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

function tunnelState(id: string, status: TunnelState["status"]): TunnelState {
  return {
    tunnelId: id,
    status,
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

describe("OpenConnectionsModal — SSH Tunnels section (live store source)", () => {
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

  it("renders tunnels from the store's live tunnelStates, not the one-shot fetch", () => {
    // Store holds a connected tunnel; the one-shot fetch returns nothing.
    useAppStore.setState({
      tunnels: [tunnelConfig("t1", "web-forward")],
      tunnelStates: { t1: tunnelState("t1", "connected") },
    });

    renderModal();

    const titles = Array.from(document.querySelectorAll(".oc-row__title")).map(
      (t) => t.textContent
    );
    expect(titles.some((t) => t?.includes("web-forward"))).toBe(true);
  });

  it("reflects a store tunnelStates change without re-opening the modal", () => {
    useAppStore.setState({
      tunnels: [tunnelConfig("t1", "web-forward")],
      tunnelStates: {},
    });

    renderModal();

    // Nothing connected yet → no tunnel rows.
    expect(tunnelRows()).toHaveLength(0);

    // A live store update (as tunnel events would push) must appear.
    act(() => {
      useAppStore.setState({ tunnelStates: { t1: tunnelState("t1", "connecting") } });
    });

    const titles = Array.from(document.querySelectorAll(".oc-row__title")).map(
      (t) => t.textContent
    );
    expect(titles.some((t) => t?.includes("web-forward"))).toBe(true);
  });
});
