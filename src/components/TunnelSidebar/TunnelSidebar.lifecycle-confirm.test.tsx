/**
 * Regression tests for UX-021.
 *
 * Stop and force-Reconnect on a LIVE tunnel used to fire immediately on a single
 * click, dropping every connection forwarded through it with no chance to
 * reconsider — while the reversible Delete already confirmed. These tests pin
 * that the sidebar prompts before stopping / reconnecting an active tunnel,
 * proceeds on confirm, aborts on cancel, and never prompts for an inactive one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import { TooltipProvider } from "@/components/ui";
import { TunnelSidebar } from "./TunnelSidebar";

const mockStopTunnel = vi.fn(() => Promise.resolve());
const mockReconnectTunnel = vi.fn(() => Promise.resolve());

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
    stopTunnel: mockStopTunnel,
    reconnectTunnel: mockReconnectTunnel,
    saveTunnel: vi.fn(),
    deleteTunnel: vi.fn(),
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

describe("TunnelSidebar — stop/reconnect confirmation (UX-021)", () => {
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

  it("prompts before stopping an active tunnel and stops only on confirm", async () => {
    seedStore(makeTunnel("tun-1", "Active Tunnel"), makeState("tun-1", "connected"));
    await renderSidebar();

    const stopBtn = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-stop-tun-1"]');
    expect(stopBtn).not.toBeNull();
    await act(async () => stopBtn!.click());
    await flush();

    // Dialog shows, stop has NOT fired yet.
    expect(
      document.querySelector('[data-testid="confirm-tunnel-lifecycle-dialog"]')
    ).not.toBeNull();
    expect(mockStopTunnel).not.toHaveBeenCalled();

    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-tunnel-lifecycle-confirm"]'
    );
    await act(async () => confirm!.click());
    await flush();
    expect(mockStopTunnel).toHaveBeenCalledWith("tun-1");
  });

  it("aborts the stop when the dialog is cancelled", async () => {
    seedStore(makeTunnel("tun-1", "Active Tunnel"), makeState("tun-1", "connected"));
    await renderSidebar();

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="tunnel-stop-tun-1"]')!.click()
    );
    await flush();

    const cancel = document.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-tunnel-lifecycle-cancel"]'
    );
    await act(async () => cancel!.click());
    await flush();

    expect(document.querySelector('[data-testid="confirm-tunnel-lifecycle-dialog"]')).toBeNull();
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  it("stops a connecting tunnel without prompting (no live forwards yet)", async () => {
    // A connecting tunnel still renders the Stop button, but it carries no
    // established forwards — stopping it is a cheap cancel, so no confirm.
    seedStore(makeTunnel("tun-1", "Connecting Tunnel"), makeState("tun-1", "connecting"));
    await renderSidebar();

    const stopBtn = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-stop-tun-1"]');
    expect(stopBtn).not.toBeNull();
    await act(async () => stopBtn!.click());
    await flush();

    expect(document.querySelector('[data-testid="confirm-tunnel-lifecycle-dialog"]')).toBeNull();
    expect(mockStopTunnel).toHaveBeenCalledWith("tun-1");
  });

  it("prompts before force-reconnecting a connected tunnel and reconnects on confirm", async () => {
    seedStore(makeTunnel("tun-1", "Live Tunnel"), makeState("tun-1", "connected"));
    await renderSidebar();

    const reconnectBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="tunnel-reconnect-tun-1"]'
    );
    expect(reconnectBtn).not.toBeNull();
    await act(async () => reconnectBtn!.click());
    await flush();

    expect(
      document.querySelector('[data-testid="confirm-tunnel-lifecycle-dialog"]')
    ).not.toBeNull();
    expect(mockReconnectTunnel).not.toHaveBeenCalled();

    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-tunnel-lifecycle-confirm"]'
    );
    await act(async () => confirm!.click());
    await flush();
    expect(mockReconnectTunnel).toHaveBeenCalledWith("tun-1");
  });
});
