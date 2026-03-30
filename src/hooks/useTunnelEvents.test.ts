import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/services/events", () => ({
  onTunnelStatusChanged: vi.fn(),
  onTunnelStatsUpdated: vi.fn(),
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import { onTunnelStatusChanged, onTunnelStatsUpdated } from "@/services/events";
import { useAppStore } from "@/store/appStore";
import { useTunnelEvents } from "./useTunnelEvents";

const mockOnStatusChanged = vi.mocked(onTunnelStatusChanged);
const mockOnStatsUpdated = vi.mocked(onTunnelStatsUpdated);

function HookConsumer() {
  useTunnelEvents();
  return null;
}

describe("useTunnelEvents", () => {
  let container: HTMLDivElement;
  let root: Root;
  let statusHandler: ((state: unknown) => void) | undefined;
  let statsHandler: ((tunnelId: string, stats: unknown) => void) | undefined;
  const unlistenStatus = vi.fn();
  const unlistenStats = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());

    mockOnStatusChanged.mockImplementation((cb) => {
      statusHandler = cb as (state: unknown) => void;
      return Promise.resolve(unlistenStatus);
    });
    mockOnStatsUpdated.mockImplementation((cb) => {
      statsHandler = cb as (tunnelId: string, stats: unknown) => void;
      return Promise.resolve(unlistenStats);
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("registers both event listeners on mount", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    expect(mockOnStatusChanged).toHaveBeenCalledTimes(1);
    expect(mockOnStatsUpdated).toHaveBeenCalledTimes(1);
  });

  it("updates tunnel state in store when status event fires", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    const tunnelState = {
      tunnelId: "t-1",
      status: "connected",
      localPort: 5432,
      error: null,
      stats: null,
    };

    await act(async () => {
      statusHandler?.(tunnelState);
    });

    expect(useAppStore.getState().tunnelStates["t-1"]).toEqual(tunnelState);
  });

  it("merges stats into existing tunnel state when stats event fires", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    // First set a base tunnel state
    const baseState = {
      tunnelId: "t-1",
      status: "connected",
      localPort: 5432,
      error: null,
      stats: null,
    };
    await act(async () => {
      statusHandler?.(baseState);
    });

    const stats = { bytesIn: 1024, bytesOut: 512, connections: 3 };
    await act(async () => {
      statsHandler?.("t-1", stats);
    });

    const stored = useAppStore.getState().tunnelStates["t-1"];
    expect(stored?.stats).toEqual(stats);
    expect(stored?.status).toBe("connected");
  });

  it("ignores stats event for unknown tunnel", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    // Stats event for a tunnel that doesn't exist yet should not crash
    await act(async () => {
      statsHandler?.("unknown-tunnel", { bytesIn: 0, bytesOut: 0 });
    });

    expect(useAppStore.getState().tunnelStates["unknown-tunnel"]).toBeUndefined();
  });

  it("unsubscribes both listeners on unmount", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    act(() => root.unmount());
    root = createRoot(container);

    expect(unlistenStatus).toHaveBeenCalledTimes(1);
    expect(unlistenStats).toHaveBeenCalledTimes(1);
  });
});
