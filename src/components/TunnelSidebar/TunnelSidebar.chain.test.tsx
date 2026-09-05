/**
 * Chained-pair rendering + teardown in the tunnel sidebar (#2597): the companion
 * renders nested directly beneath its parent, and deleting the parent prompts a
 * cascade confirmation that names the linked hop (never a silent orphan).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import { TooltipProvider } from "@/components/ui";
import { TunnelSidebar } from "./TunnelSidebar";

const mockDeleteTunnel = vi.fn(() => Promise.resolve());

vi.mock("@/store/appStore", () => {
  const state: Record<string, unknown> = {};
  const useAppStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useAppStore.setState = (patch: Record<string, unknown>) => Object.assign(state, patch);
  return { useAppStore };
});

const PARENT: TunnelConfig = {
  id: "p1",
  name: "db",
  sshConnectionId: "conn-1",
  host: { kind: "agent", agentId: "agent-1" },
  tunnelType: {
    type: "local",
    config: {
      localHost: "127.0.0.1",
      localPort: 5432,
      remoteHost: "db.internal",
      remotePort: 5432,
    },
  },
  autoStart: false,
  reconnectOnDisconnect: false,
};

const COMPANION: TunnelConfig = {
  id: "p1-hop",
  name: "db (hop on this computer)",
  sshConnectionId: "conn-agent",
  host: { kind: "thisComputer" },
  companionOf: "p1",
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "127.0.0.1", remotePort: 5432 },
  },
  autoStart: false,
  reconnectOnDisconnect: false,
};

function makeState(id: string, status: TunnelState["status"]): TunnelState {
  return {
    tunnelId: id,
    status,
    stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function seed(tunnels: TunnelConfig[], states: Record<string, TunnelState>) {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    tunnels,
    tunnelStates: states,
    connections: [],
    startTunnel: vi.fn(),
    stopTunnel: vi.fn(),
    reconnectTunnel: vi.fn(),
    saveTunnel: vi.fn(),
    deleteTunnel: mockDeleteTunnel,
    openTunnelEditorTab: vi.fn(),
  });
}

async function renderSidebar() {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <TunnelSidebar />
      </TooltipProvider>
    );
  });
  await flush();
}

describe("TunnelSidebar — chained pair (#2597)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the companion nested directly beneath its parent", async () => {
    seed([PARENT, COMPANION], {
      p1: makeState("p1", "connected"),
      "p1-hop": makeState("p1-hop", "connected"),
    });
    await renderSidebar();

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid^="tunnel-item-"]')
    );
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "tunnel-item-p1",
      "tunnel-item-p1-hop",
    ]);
    // The companion row is the nested variant.
    expect(rows[1].classList.contains("tunnel-item--nested")).toBe(true);
  });

  it("names the linked hop in the parent's cascade delete confirmation", async () => {
    seed([PARENT, COMPANION], {
      p1: makeState("p1", "connected"),
      "p1-hop": makeState("p1-hop", "connected"),
    });
    await renderSidebar();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="tunnel-delete-p1"]')!.click();
    });
    await flush();

    const dialog = document.querySelector('[data-testid="confirm-delete-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("db (hop on this computer)");
    expect(mockDeleteTunnel).not.toHaveBeenCalled();
  });

  it("warns that deleting the companion alone breaks localhost", async () => {
    seed([PARENT, COMPANION], {
      p1: makeState("p1", "connected"),
      "p1-hop": makeState("p1-hop", "connected"),
    });
    await renderSidebar();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="tunnel-delete-p1-hop"]')!.click();
    });
    await flush();

    const dialog = document.querySelector('[data-testid="confirm-delete-dialog"]');
    expect(dialog!.textContent).toContain("localhost will stop reaching the port");
    expect(mockDeleteTunnel).not.toHaveBeenCalled();
  });
});
