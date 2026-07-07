import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/services/events", () => ({
  onEmbeddedServerStatusChanged: vi.fn(),
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

vi.mock("@/services/embeddedServerApi", () => ({
  listEmbeddedServers: vi.fn(() => Promise.resolve([])),
  saveEmbeddedServer: vi.fn(() => Promise.resolve()),
  deleteEmbeddedServer: vi.fn(() => Promise.resolve()),
  startEmbeddedServer: vi.fn(() => Promise.resolve()),
  stopEmbeddedServer: vi.fn(() => Promise.resolve()),
  getEmbeddedServerStates: vi.fn(() => Promise.resolve([])),
  createAndStartServer: vi.fn(() => Promise.resolve("")),
}));

import { onEmbeddedServerStatusChanged } from "@/services/events";
import { getEmbeddedServerStates } from "@/services/embeddedServerApi";
import { useAppStore } from "@/store/appStore";
import { useEmbeddedServerEvents } from "./useEmbeddedServerEvents";

const mockOnStatusChanged = vi.mocked(onEmbeddedServerStatusChanged);
const mockGetStates = vi.mocked(getEmbeddedServerStates);

function HookConsumer() {
  useEmbeddedServerEvents();
  return null;
}

describe("useEmbeddedServerEvents", () => {
  let container: HTMLDivElement;
  let root: Root;
  let statusChangedHandler: ((state: unknown) => void) | undefined;
  const unlisten = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());

    mockOnStatusChanged.mockImplementation((cb) => {
      statusChangedHandler = cb as (state: unknown) => void;
      return Promise.resolve(unlisten);
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("registers the status-changed event listener on mount", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    expect(mockOnStatusChanged).toHaveBeenCalledTimes(1);
  });

  it("updates embedded server state in store when event fires", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    const state = { serverId: "srv-1", status: "running", port: 69, error: null };
    await act(async () => {
      statusChangedHandler?.(state);
    });

    expect(useAppStore.getState().embeddedServerStates["srv-1"]).toEqual(state);
  });

  it("updates store for multiple server status events", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    const state1 = { serverId: "srv-1", status: "running", port: 21, error: null };
    const state2 = { serverId: "srv-2", status: "stopped", port: 69, error: null };

    await act(async () => {
      statusChangedHandler?.(state1);
    });
    await act(async () => {
      statusChangedHandler?.(state2);
    });

    expect(useAppStore.getState().embeddedServerStates["srv-1"]).toEqual(state1);
    expect(useAppStore.getState().embeddedServerStates["srv-2"]).toEqual(state2);
  });

  it("unsubscribes listener on unmount", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    act(() => root.unmount());
    root = createRoot(container);

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  // The status-changed event only fires on transitions, so live traffic/uptime
  // would stay frozen while a server runs. The hook must poll the real states
  // while any server is running so the sidebar updates continuously (#1145, G6).
  it("polls live server states on an interval while a server is running", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(createElement(HookConsumer));
      });

      // No server running yet: no polling should occur.
      mockGetStates.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(mockGetStates).not.toHaveBeenCalled();

      // A running server arrives via the status event -> polling should begin.
      await act(async () => {
        statusChangedHandler?.({
          serverId: "srv-1",
          status: "running",
          stats: {
            activeConnections: 0,
            totalConnections: 0,
            bytesSent: 0,
            bytesReceived: 0,
          },
        });
      });

      mockGetStates.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(3200);
      });
      expect(mockGetStates.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling once no server is running", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(createElement(HookConsumer));
      });

      await act(async () => {
        statusChangedHandler?.({
          serverId: "srv-1",
          status: "running",
          stats: {
            activeConnections: 0,
            totalConnections: 0,
            bytesSent: 0,
            bytesReceived: 0,
          },
        });
      });

      // Server stops -> the running flag flips false and the interval clears.
      await act(async () => {
        statusChangedHandler?.({
          serverId: "srv-1",
          status: "stopped",
          stats: {
            activeConnections: 0,
            totalConnections: 0,
            bytesSent: 0,
            bytesReceived: 0,
          },
        });
      });

      mockGetStates.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(mockGetStates).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
