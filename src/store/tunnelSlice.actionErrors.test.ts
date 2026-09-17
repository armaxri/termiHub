/**
 * Error/rejection branches of the tunnel slice's lifecycle actions (#2979).
 *
 * The happy paths and the start/reconnect first-connect toast are pinned by
 * `tunnelSlice.startToast.test.ts` / `tunnelSlice.projection.test.ts`; this file
 * exercises the previously-uncovered catch arms — a rejected intent ack for
 * save/start/stop/reconnect (each logs, surfaces a failure toast where it has
 * one, and re-throws) plus the loadTunnels subscribe failure — and the
 * `?? "tunnel"` name fallback when the id is unknown.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { IntentAck, ProjectionCacheState } from "@/services/transport";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import { onFrontendLog } from "@/utils/frontendLog";

const { clientHooks, dispatchMock, startMock, toastMock } = vi.hoisted(() => ({
  clientHooks: {
    listener: null as null | ((state: ProjectionCacheState) => void),
  },
  dispatchMock: vi.fn(),
  startMock: vi.fn(async () => {}),
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
    async start() {
      await startMock();
    }
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

function makeState(id: string, status: TunnelState["status"]): TunnelState {
  return {
    tunnelId: id,
    status,
    stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
  };
}

function pushView(states: Record<string, TunnelState>, tunnels: TunnelConfig[]): void {
  clientHooks.listener?.({ version: 1, view: { tunnels, states } });
}

const accepted: IntentAck = { intentId: "intent-test", status: "accepted", produced: [] };
const rejected: IntentAck = {
  intentId: "intent-test",
  status: "rejected",
  error: { code: "boom", message: "backend refused" },
  produced: [],
};

async function captureLogs(fn: () => Promise<void> | void): Promise<string[]> {
  const messages: string[] = [];
  const off = onFrontendLog((e) => messages.push(e.message));
  try {
    await fn();
  } finally {
    off();
  }
  return messages;
}

async function loadWith(tunnels: TunnelConfig[], states: Record<string, TunnelState>) {
  await useAppStore.getState().loadTunnels();
  pushView(states, tunnels);
}

describe("tunnelSlice — action rejection branches (#2979)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    clientHooks.listener = null;
    vi.clearAllMocks();
    startMock.mockResolvedValue(undefined);
    dispatchMock.mockResolvedValue(accepted);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loadTunnels swallows a subscribe failure and logs it", async () => {
    startMock.mockRejectedValueOnce(new Error("no socket"));
    const logs = await captureLogs(() => useAppStore.getState().loadTunnels());
    expect(logs.some((m) => m.includes("no socket"))).toBe(true);
    // The store stays on its empty defaults rather than throwing.
    expect(useAppStore.getState().tunnels).toEqual([]);
  });

  it("saveTunnel re-throws and logs when the create intent is rejected", async () => {
    dispatchMock.mockResolvedValueOnce(rejected);
    const cfg = makeTunnel("t1", "db");
    const logs = await captureLogs(async () => {
      await expect(useAppStore.getState().saveTunnel(cfg)).rejects.toThrow("backend refused");
    });
    expect(logs.some((m) => m.includes("Failed to save tunnel"))).toBe(true);
  });

  it("startTunnel surfaces a failure toast and re-throws on a rejected ack", async () => {
    await loadWith([makeTunnel("t1", "db")], { t1: makeState("t1", "disconnected") });
    dispatchMock.mockResolvedValueOnce(rejected);
    await expect(useAppStore.getState().startTunnel("t1")).rejects.toThrow("backend refused");
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to start db"),
      expect.objectContaining({ id: "toast-id" })
    );
    // The in-flight guard was released in `finally`, so a retry can dispatch again.
    dispatchMock.mockResolvedValueOnce(accepted);
    await expect(useAppStore.getState().startTunnel("t1")).resolves.toBeUndefined();
  });

  it("stopTunnel surfaces a failure toast and re-throws on a rejected ack", async () => {
    await loadWith([makeTunnel("t1", "db")], { t1: makeState("t1", "connected") });
    dispatchMock.mockResolvedValueOnce(rejected);
    await expect(useAppStore.getState().stopTunnel("t1")).rejects.toThrow("backend refused");
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to stop db"),
      expect.objectContaining({ id: "toast-id" })
    );
  });

  it("reconnectTunnel surfaces a failure toast and re-throws on a rejected ack", async () => {
    await loadWith([makeTunnel("t1", "db")], { t1: makeState("t1", "connected") });
    dispatchMock.mockResolvedValueOnce(rejected);
    await expect(useAppStore.getState().reconnectTunnel("t1")).rejects.toThrow("backend refused");
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to reconnect db"),
      expect.objectContaining({ id: "toast-id" })
    );
  });

  it("falls back to the 'tunnel' label when the id is unknown", async () => {
    await loadWith([], {});
    dispatchMock.mockResolvedValueOnce(rejected);
    await expect(useAppStore.getState().stopTunnel("ghost")).rejects.toThrow();
    expect(toastMock.loading).toHaveBeenCalledWith("Stopping tunnel…");
  });
});
