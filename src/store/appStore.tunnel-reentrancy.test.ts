/**
 * Regression tests for GAP 4 from the SSH tunnel audit (#1141).
 *
 * Neither `startTunnel` nor `stopTunnel` in the store guarded against being
 * fired again while a prior call for the same tunnel was still in flight.
 * Rapid double-clicks therefore produced two backend calls and spurious
 * "already active/connecting" error toasts, and could flip the visible state.
 *
 * These tests pin that a second `startTunnel`/`stopTunnel` for the same id,
 * issued before the first call resolves, is a no-op (only ONE backend call).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the service modules the store imports at module load. We only care about
// tunnelApi + the toast primitive here, but the store pulls in the full graph.
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

vi.mock("@/services/tunnelApi", () => ({
  getTunnels: vi.fn(() => Promise.resolve([])),
  saveTunnel: vi.fn(),
  deleteTunnel: vi.fn(() => Promise.resolve()),
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
  getTunnelStatuses: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      loading: vi.fn(() => "toast-id"),
      success: vi.fn(),
      error: vi.fn(),
    },
  };
});

import { useAppStore } from "./appStore";
import { startTunnel as apiStartTunnel, stopTunnel as apiStopTunnel } from "@/services/tunnelApi";
import type { TunnelConfig } from "@/types/tunnel";

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

/** A promise that never resolves on its own — keeps the backend call "in flight". */
function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("appStore — tunnel start/stop re-entrancy guard (GAP 4, #1141)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ tunnels: [makeTunnel("tun-1", "My Tunnel")] });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ignores a second startTunnel while the first is still in flight", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(apiStartTunnel).mockReturnValueOnce(deferred.promise);

    // First click — kicks off the backend call (still pending).
    const first = useAppStore.getState().startTunnel("tun-1");
    // Second click before the first resolves — must be a no-op.
    await useAppStore.getState().startTunnel("tun-1");

    expect(apiStartTunnel).toHaveBeenCalledTimes(1);

    // Let the first call finish so the in-flight guard clears.
    deferred.resolve();
    await first;

    // A later start (after the first resolved) is allowed again.
    vi.mocked(apiStartTunnel).mockResolvedValueOnce(undefined);
    await useAppStore.getState().startTunnel("tun-1");
    expect(apiStartTunnel).toHaveBeenCalledTimes(2);
  });

  it("ignores a second stopTunnel while the first is still in flight", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(apiStopTunnel).mockReturnValueOnce(deferred.promise);

    const first = useAppStore.getState().stopTunnel("tun-1");
    await useAppStore.getState().stopTunnel("tun-1");

    expect(apiStopTunnel).toHaveBeenCalledTimes(1);

    deferred.resolve();
    await first;

    vi.mocked(apiStopTunnel).mockResolvedValueOnce(undefined);
    await useAppStore.getState().stopTunnel("tun-1");
    expect(apiStopTunnel).toHaveBeenCalledTimes(2);
  });

  it("tracks start and stop in-flight independently per tunnel id", async () => {
    const startDeferred = makeDeferred<void>();
    vi.mocked(apiStartTunnel).mockReturnValueOnce(startDeferred.promise);
    vi.mocked(apiStopTunnel).mockResolvedValue(undefined);

    // Start tun-1 is in flight; stopping a *different* tunnel is unaffected.
    const startFirst = useAppStore.getState().startTunnel("tun-1");
    await useAppStore.getState().stopTunnel("tun-2");

    expect(apiStartTunnel).toHaveBeenCalledTimes(1);
    expect(apiStopTunnel).toHaveBeenCalledTimes(1);

    startDeferred.resolve();
    await startFirst;
  });
});
