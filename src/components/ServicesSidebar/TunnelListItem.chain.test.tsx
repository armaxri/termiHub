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
import { NO_CONTEXT } from "@/test/serviceContext";
import { withTooltip } from "@/test/tooltip";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";

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
    context: NO_CONTEXT,
    onStart: noop,
    onStop: noop,
    onReconnect: noop,
    onEdit: noop,
    onDuplicate: noop,
    onDelete: noop,
    onUsePort: noop,
  };

  it("names the companion after what it is for, and where it can be used", () => {
    render(
      <TunnelListItem
        {...common}
        tunnel={COMPANION}
        state={stateOf("p1-hop", "connected")}
        nested
        pairStatus="connected"
      />
    );
    expect(q('[data-testid="tunnel-name-p1-hop"]')?.textContent).toBe("On this computer");
    expect(q('[data-testid="tunnel-address-p1-hop"]')?.textContent).toContain("only this computer");
    expect(q('[data-testid="tunnel-item-p1-hop"]')?.getAttribute("aria-description")).toContain(
      "Runs on this computer"
    );
  });

  it("says nothing on the parent row while the pair works", () => {
    render(
      <TunnelListItem
        {...common}
        tunnel={PARENT}
        state={stateOf("p1", "connected")}
        pairStatus="connected"
      />
    );
    expect(q('[data-testid="tunnel-reason-p1"]')).toBeNull();
    expect(q('[data-testid="tunnel-status-p1"]')?.className).toContain("success");
  });

  it("says on the parent row that it cannot be used here, and is not green", () => {
    render(
      <TunnelListItem
        {...common}
        tunnel={PARENT}
        state={stateOf("p1", "connected")}
        pairStatus="degraded"
      />
    );
    expect(q('[data-testid="tunnel-reason-p1"]')?.textContent).toBe(
      "Does not work on this computer, see below."
    );
    expect(q('[data-testid="tunnel-status-p1"]')?.className).toContain("warning");
    // Its address is another program's on this computer.
    expect(q('[data-testid="tunnel-copy-address-p1"]')).toBeNull();
    expect(container.textContent).not.toMatch(/linked|degraded|hop down/i);
  });

  it("offers a taken port's remedies on the companion, each once", () => {
    const onStart = vi.fn();
    const onEdit = vi.fn();
    const onUsePort = vi.fn();
    render(
      <TunnelListItem
        {...common}
        tunnel={COMPANION}
        state={{ ...stateOf("p1-hop", "error"), error: "taken", cause: "portInUse" }}
        nested
        pairStatus="degraded"
        onStart={onStart}
        onEdit={onEdit}
        onUsePort={onUsePort}
      />
    );
    const port = COMPANION.tunnelType.config.localPort as number;
    act(() => (q('[data-testid="tunnel-use-port-p1-hop"]') as HTMLButtonElement).click());
    expect(onUsePort).toHaveBeenCalledWith("p1-hop", port + 1);
    act(() => (q('[data-testid="tunnel-edit-port-p1-hop"]') as HTMLButtonElement).click());
    expect(onEdit).toHaveBeenCalledWith("p1-hop");
    expect(container.textContent).not.toContain("Retry");
    expect(onStart).not.toHaveBeenCalled();
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
