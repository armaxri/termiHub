/**
 * Regression tests for GAP 7 from the SSH tunnel audit (#1141).
 *
 * Deleting an ACTIVE (connecting / connected / reconnecting) tunnel silently
 * killed it with no chance to reconsider. These tests pin that the sidebar
 * prompts for confirmation before deleting an active tunnel, and deletes an
 * inactive tunnel directly (no prompt).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import { TooltipProvider } from "@/components/ui";
import { TunnelSidebar } from "./TunnelSidebar";

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

const mockDeleteTunnel = vi.fn(() => Promise.resolve());

vi.mock("@/store/appStore", () => {
  const state: Record<string, unknown> = {};
  const useAppStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useAppStore.setState = (patch: Record<string, unknown>) => Object.assign(state, patch);
  return { useAppStore };
});

function makeTunnel(id: string, name: string): TunnelConfig {
  return {
    id,
    name,
    sshConnectionId: "conn-1",
    tunnelType: {
      type: "local",
      config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "127.0.0.1", remotePort: 80 },
    },
    autoStart: false,
    reconnectOnDisconnect: false,
  };
}

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

function seedStore(tunnel: TunnelConfig, state?: TunnelState) {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    tunnels: [tunnel],
    tunnelStates: state ? { [tunnel.id]: state } : {},
    connections: [],
    startTunnel: vi.fn(),
    stopTunnel: vi.fn(),
    saveTunnel: vi.fn(),
    deleteTunnel: mockDeleteTunnel,
    openTunnelEditorTab: vi.fn(),
  });
}

describe("TunnelSidebar — delete confirmation (GAP 7, #1141)", () => {
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

  it("prompts for confirmation before deleting an active tunnel", async () => {
    seedStore(makeTunnel("tun-1", "Active Tunnel"), makeState("tun-1", "connected"));
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <TunnelSidebar />
        </TooltipProvider>
      );
    });
    await flush();

    const deleteBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="tunnel-delete-tun-1"]'
    );
    expect(deleteBtn).not.toBeNull();
    await act(async () => {
      deleteBtn!.click();
    });
    await flush();

    // The confirm dialog must appear, and delete must NOT have fired yet.
    const dialog = document.querySelector('[data-testid="confirm-delete-dialog"]');
    expect(dialog).not.toBeNull();
    expect(mockDeleteTunnel).not.toHaveBeenCalled();

    // Confirming the dialog performs the delete.
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-delete-confirm"]'
    );
    expect(confirm).not.toBeNull();
    await act(async () => {
      confirm!.click();
    });
    await flush();
    expect(mockDeleteTunnel).toHaveBeenCalledWith("tun-1");
  });

  it("deletes an inactive tunnel without prompting", async () => {
    seedStore(makeTunnel("tun-2", "Idle Tunnel"), makeState("tun-2", "disconnected"));
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <TunnelSidebar />
        </TooltipProvider>
      );
    });
    await flush();

    const deleteBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="tunnel-delete-tun-2"]'
    );
    await act(async () => {
      deleteBtn!.click();
    });
    await flush();

    expect(document.querySelector('[data-testid="confirm-delete-dialog"]')).toBeNull();
    expect(mockDeleteTunnel).toHaveBeenCalledWith("tun-2");
  });
});
