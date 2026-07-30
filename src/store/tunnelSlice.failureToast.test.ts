/**
 * First-connect failure-toast parity for the tunnel slice (#2169).
 *
 * After the projection migration (#2150) `tunnel.start` / `tunnel.reconnect` are
 * fire-and-forget: the ack only confirms the start was *accepted*, so a failure
 * during the SSH handshake arrives as a projected `error` status rather than the
 * old synchronous red toast. These tests pin that the slice re-raises the failure
 * toast — driven purely from the projected status transition — and only for a
 * start/reconnect THIS client dispatched (never a mid-session death or another
 * client's start, which surface only as the Error status badge).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { IntentAck, ProjectionCacheState } from "@/services/transport";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";

const { clientHooks, dispatchMock, toastMock } = vi.hoisted(() => ({
  clientHooks: {
    listener: null as null | ((state: ProjectionCacheState) => void),
  },
  dispatchMock: vi.fn(),
  toastMock: { loading: vi.fn(() => "toast-id"), success: vi.fn(), error: vi.fn() },
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

/** Push a projected `tunnels` view through the region client's onChange listener. */
function pushView(states: Record<string, TunnelState>, tunnels: TunnelConfig[]): void {
  clientHooks.listener?.({ version: 1, view: { tunnels, states } });
}

const accepted: IntentAck = { intentId: "intent-test", status: "accepted", produced: [] };

describe("tunnelSlice — first-connect failure toast (#2169)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    clientHooks.listener = null;
    vi.clearAllMocks();
    dispatchMock.mockResolvedValue(accepted);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("re-raises a failure toast when a client-started tunnel transitions to error", async () => {
    const t1 = makeTunnel("t1", "db");
    await useAppStore.getState().loadTunnels();
    pushView({ t1: makeState("t1", "disconnected") }, [t1]);

    await useAppStore.getState().startTunnel("t1");
    toastMock.error.mockClear(); // ignore any ack-path toast; assert on the projected one

    // Handshake in progress, then fails during the connect.
    pushView({ t1: makeState("t1", "connecting") }, [t1]);
    expect(toastMock.error).not.toHaveBeenCalled();

    pushView({ t1: makeState("t1", "error", "connection refused") }, [t1]);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(toastMock.error.mock.calls[0][0]).toContain("Failed to start db");
    expect(toastMock.error.mock.calls[0][0]).toContain("connection refused");
  });

  it("does not re-toast on a repeated/coalesced diff that still shows error", async () => {
    const t1 = makeTunnel("t1", "db");
    await useAppStore.getState().loadTunnels();
    pushView({ t1: makeState("t1", "disconnected") }, [t1]);
    await useAppStore.getState().startTunnel("t1");
    toastMock.error.mockClear();

    pushView({ t1: makeState("t1", "connecting") }, [t1]);
    pushView({ t1: makeState("t1", "error", "connection refused") }, [t1]);
    pushView({ t1: makeState("t1", "error", "connection refused") }, [t1]); // repeat
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  it("does not toast for a tunnel this client never started (mid-session death / other client)", async () => {
    const t1 = makeTunnel("t1", "db");
    await useAppStore.getState().loadTunnels();
    // No startTunnel dispatched here — the tunnel was already connected and dies.
    pushView({ t1: makeState("t1", "connected") }, [t1]);
    pushView({ t1: makeState("t1", "error", "pipe broke") }, [t1]);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("does not toast on a later mid-session death after a successful first connect", async () => {
    const t1 = makeTunnel("t1", "db");
    await useAppStore.getState().loadTunnels();
    pushView({ t1: makeState("t1", "disconnected") }, [t1]);
    await useAppStore.getState().startTunnel("t1");
    toastMock.error.mockClear();

    // Connects successfully — the watch resolves.
    pushView({ t1: makeState("t1", "connecting") }, [t1]);
    pushView({ t1: makeState("t1", "connected") }, [t1]);
    // Later the tunnel dies mid-session: badge only, no first-connect toast.
    pushView({ t1: makeState("t1", "error", "pipe broke") }, [t1]);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("labels a failed reconnect as 'Failed to reconnect'", async () => {
    const t1 = makeTunnel("t1", "db");
    await useAppStore.getState().loadTunnels();
    pushView({ t1: makeState("t1", "connected") }, [t1]);

    await useAppStore.getState().reconnectTunnel("t1");
    toastMock.error.mockClear();

    // Reconnect tears down then fails on the fresh handshake.
    pushView({ t1: makeState("t1", "disconnected") }, [t1]);
    pushView({ t1: makeState("t1", "connecting") }, [t1]);
    pushView({ t1: makeState("t1", "error", "auth failed") }, [t1]);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(toastMock.error.mock.calls[0][0]).toContain("Failed to reconnect db");
  });

  it("scopes the watch to the current session — a re-subscribe clears pending watches", async () => {
    const t1 = makeTunnel("t1", "db");
    await useAppStore.getState().loadTunnels();
    pushView({ t1: makeState("t1", "disconnected") }, [t1]);
    await useAppStore.getState().startTunnel("t1");
    toastMock.error.mockClear();

    // Re-init (e.g. a store re-subscribe) drops the pending watch with the client.
    await useAppStore.getState().loadTunnels();
    pushView({ t1: makeState("t1", "connecting") }, [t1]);
    pushView({ t1: makeState("t1", "error", "connection refused") }, [t1]);
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});
