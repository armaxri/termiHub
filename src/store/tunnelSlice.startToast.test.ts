/**
 * Start/reconnect toast lifecycle for the tunnel slice (UX-023).
 *
 * After the projection migration (#2150) `tunnel.start` / `tunnel.reconnect` are
 * fire-and-forget. The success toast must NOT resolve on the intent ack (which
 * only confirms the start was *accepted*) — a premature green "Started" would
 * appear a beat before the real handshake, sometimes just ahead of a failure
 * toast. These tests pin that the pending `loading` toast is held across the ack
 * and only settles then: it is dismissed on the actual `connected` transition
 * (the tunnel's status dot shows it; no success toast, #5859),
 * or to error on a `→ error` transition (the #2169 first-connect failure path).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { IntentAck, ProjectionCacheState } from "@/services/transport";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";

const { clientHooks, dispatchMock, toastMock } = vi.hoisted(() => ({
  clientHooks: {
    listener: null as null | ((state: ProjectionCacheState) => void),
  },
  dispatchMock: vi.fn(),
  toastMock: {
    loading: vi.fn(() => "toast-id"),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
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
  createTransport: () => ({ dispatch: dispatchMock, subscribe: vi.fn(), resync: vi.fn() }),
  newClientId: () => "client-test",
  newIntentId: () => "intent-test",
  ProjectionClient: class {
    onChange(listener: (state: ProjectionCacheState) => void) {
      clientHooks.listener = listener;
      return () => {
        clientHooks.listener = null;
      };
    }
    async start() {}
    stop() {}
  },
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: toastMock };
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

function makeState(id: string, status: TunnelState["status"], error?: string): TunnelState {
  return {
    tunnelId: id,
    status,
    error,
    stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
  };
}

function pushView(states: Record<string, TunnelState>, tunnels: TunnelConfig[]): void {
  clientHooks.listener?.({ version: 1, view: { tunnels, states } });
}

const accepted: IntentAck = { intentId: "intent-test", status: "accepted", produced: [] };

describe("tunnelSlice — start/reconnect toast resolves on connected, not on ack (UX-023)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    clientHooks.listener = null;
    vi.clearAllMocks();
    dispatchMock.mockResolvedValue(accepted);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // #6028: the row says how it goes on from here; a pending toast would never end.
  it.each(["notReachable", "waiting", "stopping"] as const)(
    "dismisses the pending toast when the start ends as %s",
    async (status) => {
      const t1 = makeTunnel("t1", "db");
      await useAppStore.getState().loadTunnels();
      pushView({ t1: makeState("t1", "disconnected") }, [t1]);
      await useAppStore.getState().startTunnel("t1");
      pushView({ t1: makeState("t1", "connecting") }, [t1]);
      expect(toastMock.dismiss).not.toHaveBeenCalled();
      pushView({ t1: makeState("t1", status, "why") }, [t1]);
      expect(toastMock.dismiss).toHaveBeenCalledWith("toast-id");
      expect(toastMock.error).not.toHaveBeenCalled();
    }
  );

  it("holds the toast pending on ack and dismisses it only on connected", async () => {
    const t1 = makeTunnel("t1", "db");
    await useAppStore.getState().loadTunnels();
    pushView({ t1: makeState("t1", "disconnected") }, [t1]);

    await useAppStore.getState().startTunnel("t1");
    // Ack accepted, but the tunnel is not connected yet — no success toast.
    expect(toastMock.loading).toHaveBeenCalledWith("Starting db…");
    expect(toastMock.success).not.toHaveBeenCalled();

    // Handshake in progress — still no success.
    pushView({ t1: makeState("t1", "connecting") }, [t1]);
    expect(toastMock.success).not.toHaveBeenCalled();

    // Still pending while connecting.
    expect(toastMock.dismiss).not.toHaveBeenCalled();

    // Actually connected — the pending toast goes; the status dot shows it (#5859).
    pushView({ t1: makeState("t1", "connected") }, [t1]);
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.dismiss).toHaveBeenCalledWith("toast-id");
  });

  it("resolves the same pending toast to error when the first connect fails", async () => {
    const t1 = makeTunnel("t1", "db");
    await useAppStore.getState().loadTunnels();
    pushView({ t1: makeState("t1", "disconnected") }, [t1]);

    await useAppStore.getState().startTunnel("t1");
    expect(toastMock.success).not.toHaveBeenCalled();

    pushView({ t1: makeState("t1", "connecting") }, [t1]);
    pushView({ t1: makeState("t1", "error", "connection refused") }, [t1]);
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(toastMock.error).toHaveBeenCalledWith("Failed to start db: connection refused", {
      id: "toast-id",
    });
  });

  it("dismisses a reconnect toast on connected", async () => {
    const t1 = makeTunnel("t1", "db");
    await useAppStore.getState().loadTunnels();
    pushView({ t1: makeState("t1", "connected") }, [t1]);

    await useAppStore.getState().reconnectTunnel("t1");
    expect(toastMock.loading).toHaveBeenCalledWith("Reconnecting db…");
    expect(toastMock.success).not.toHaveBeenCalled();

    pushView({ t1: makeState("t1", "disconnected") }, [t1]);
    pushView({ t1: makeState("t1", "connecting") }, [t1]);
    pushView({ t1: makeState("t1", "connected") }, [t1]);
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.dismiss).toHaveBeenCalledWith("toast-id");
  });

  it("does not toast on a later mid-session reconnect blip", async () => {
    const t1 = makeTunnel("t1", "db");
    await useAppStore.getState().loadTunnels();
    pushView({ t1: makeState("t1", "disconnected") }, [t1]);

    await useAppStore.getState().startTunnel("t1");
    pushView({ t1: makeState("t1", "connected") }, [t1]);
    expect(toastMock.dismiss).toHaveBeenCalledTimes(1);

    // A later disconnect/reconnect the user never initiated is a badge, not a toast.
    pushView({ t1: makeState("t1", "disconnected") }, [t1]);
    pushView({ t1: makeState("t1", "connected") }, [t1]);
    expect(toastMock.dismiss).toHaveBeenCalledTimes(1);
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("dismisses a still-pending toast when the session re-subscribes", async () => {
    const t1 = makeTunnel("t1", "db");
    await useAppStore.getState().loadTunnels();
    pushView({ t1: makeState("t1", "disconnected") }, [t1]);

    await useAppStore.getState().startTunnel("t1");
    // Re-subscribe before the connect settles: the orphaned loading toast is dismissed.
    await useAppStore.getState().loadTunnels();
    expect(toastMock.dismiss).toHaveBeenCalledWith("toast-id");
  });
});
