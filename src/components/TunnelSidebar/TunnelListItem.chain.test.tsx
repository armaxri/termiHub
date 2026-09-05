/**
 * Chained-pair rendering for the tunnel list item (#2597): a companion nests
 * under its parent with a link badge + "this computer" host badge; a parent with
 * a companion shows the combined "Linked · …" status; a degraded pair shows the
 * inline fix (Retry / different local port); a redundant companion offers removal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { TunnelListItem } from "./TunnelListItem";
import { withTooltip } from "@/test/tooltip";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import type { SavedConnection } from "@/types/connection";

const noop = () => {};

const PARENT: TunnelConfig = {
  id: "p1",
  name: "db",
  sshConnectionId: "ssh-1",
  autoStart: false,
  reconnectOnDisconnect: false,
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
};

const COMPANION: TunnelConfig = {
  id: "p1-hop",
  name: "db (hop on this computer)",
  sshConnectionId: "ssh-agent",
  autoStart: false,
  reconnectOnDisconnect: false,
  host: { kind: "thisComputer" },
  companionOf: "p1",
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "127.0.0.1", remotePort: 5432 },
  },
};

function stateOf(id: string, status: TunnelState["status"]): TunnelState {
  return {
    tunnelId: id,
    status,
    stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
  };
}

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactElement): void {
  act(() => {
    root.render(withTooltip(node));
  });
}

function q(sel: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(sel);
}

setupAgentsRegion();

describe("TunnelListItem — chained pair (#2597)", () => {
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

  const common = {
    connections: [] as SavedConnection[],
    onStart: noop,
    onStop: noop,
    onReconnect: noop,
    onEdit: noop,
    onDuplicate: noop,
    onDelete: noop,
  };

  it("nests the companion with a link badge and a 'this computer' host badge", () => {
    render(
      <TunnelListItem
        {...common}
        tunnel={COMPANION}
        state={stateOf("p1-hop", "connected")}
        nested
        pairStatus="connected"
      />
    );
    expect(q('[aria-label="Chained companion"]')).toBeTruthy();
    expect(q('[data-testid="tunnel-host-p1-hop"]')?.textContent).toContain("this computer");
  });

  it("shows the combined 'Linked · connected' status on the parent row", () => {
    render(
      <TunnelListItem
        {...common}
        tunnel={PARENT}
        state={stateOf("p1", "connected")}
        pairStatus="connected"
      />
    );
    const pair = q('[data-testid="tunnel-pair-status-p1"]');
    expect(pair?.textContent).toContain("Linked · connected");
    expect(pair?.getAttribute("data-warn")).toBe("false");
  });

  it("renders the degraded inline fix (Retry + different local port) on the companion", () => {
    const onStart = vi.fn();
    const onEdit = vi.fn();
    render(
      <TunnelListItem
        {...common}
        tunnel={COMPANION}
        state={stateOf("p1-hop", "error")}
        nested
        pairStatus="degraded"
        onStart={onStart}
        onEdit={onEdit}
      />
    );
    const fix = q('[data-testid="tunnel-degraded-fix-p1-hop"]');
    expect(fix).toBeTruthy();
    act(() => (q('[data-testid="tunnel-degraded-retry-p1-hop"]') as HTMLButtonElement).click());
    expect(onStart).toHaveBeenCalledWith("p1-hop");
    act(() => (q('[data-testid="tunnel-degraded-port-p1-hop"]') as HTMLButtonElement).click());
    expect(onEdit).toHaveBeenCalledWith("p1-hop");
  });

  it("offers to remove a redundant companion on the parent row", () => {
    const onRemoveCompanion = vi.fn();
    render(
      <TunnelListItem
        {...common}
        tunnel={PARENT}
        state={stateOf("p1", "connected")}
        pairStatus="connected"
        companionRedundant
        onRemoveCompanion={onRemoveCompanion}
      />
    );
    const remove = q('[data-testid="tunnel-remove-redundant-p1"]') as HTMLButtonElement | null;
    expect(remove).toBeTruthy();
    act(() => remove!.click());
    expect(onRemoveCompanion).toHaveBeenCalledOnce();
  });
});
