/**
 * The tunnel slice as a projection cache (#2150).
 *
 * After the Phase-2 pilot migration the slice no longer owns authoritative
 * tunnel state: `loadTunnels` subscribes to the shared `tunnels` projection
 * region and mirrors each pushed view model into `tunnels` / `tunnelStates`,
 * which the UI renders from unchanged. These tests pin that mirroring — a pushed
 * region view populates the slice, and an empty view clears it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { ProjectionCacheState } from "@/services/transport";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";

const { clientHooks } = vi.hoisted(() => ({
  clientHooks: {
    listener: null as null | ((state: ProjectionCacheState) => void),
    started: false,
    stopped: 0,
  },
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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/transport", () => ({
  createTransport: () => ({ dispatch: vi.fn(), subscribe: vi.fn(), resync: vi.fn() }),
  newClientId: () => "client-test",
  newIntentId: () => "intent-test",
  ProjectionClient: class {
    onChange(listener: (state: ProjectionCacheState) => void) {
      clientHooks.listener = listener;
      return () => {
        clientHooks.listener = null;
      };
    }
    async start() {
      clientHooks.started = true;
    }
    stop() {
      clientHooks.stopped += 1;
    }
  },
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { loading: vi.fn(() => "toast-id"), success: vi.fn(), error: vi.fn() },
  };
});

import { useAppStore } from "./appStore";

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

describe("tunnelSlice — projection-fed cache (#2150)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    clientHooks.listener = null;
    clientHooks.started = false;
    clientHooks.stopped = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes to the tunnels region and mirrors a pushed view into the slice", async () => {
    await useAppStore.getState().loadTunnels();

    expect(clientHooks.started).toBe(true);
    expect(clientHooks.listener).toBeTypeOf("function");

    clientHooks.listener?.({
      version: 3,
      view: {
        tunnels: [makeTunnel("t1", "db"), makeTunnel("t2", "socks")],
        states: { t1: makeState("t1", "connected"), t2: makeState("t2", "disconnected") },
      },
    });

    expect(useAppStore.getState().tunnels.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(useAppStore.getState().tunnelStates.t1.status).toBe("connected");
    expect(useAppStore.getState().tunnelStates.t2.status).toBe("disconnected");
  });

  it("treats a missing/empty view as an empty domain", async () => {
    useAppStore.setState({ tunnels: [makeTunnel("t1", "db")] });
    await useAppStore.getState().loadTunnels();

    clientHooks.listener?.({ version: 0, view: undefined });

    expect(useAppStore.getState().tunnels).toEqual([]);
    expect(useAppStore.getState().tunnelStates).toEqual({});
  });
});
