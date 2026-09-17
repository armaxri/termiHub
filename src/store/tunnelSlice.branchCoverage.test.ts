/**
 * Residual branch coverage for the tunnel slice (TFE-006).
 *
 * The lifecycle happy paths, the first-connect toast, the rejection/catch arms
 * and the start/stop re-entrancy guards are pinned by
 * `tunnelSlice.projection` / `.startToast` / `.failureToast` / `.actionErrors`
 * and `appStore.tunnel-reentrancy` / `.tunnel-delete`. This file drives the few
 * conditionals those leave unexecuted:
 * - `reconnectTunnel`'s re-entrancy guard (a reconnect issued while a start OR a
 *   stop for the same id is still in flight is a no-op — the reconnect twin of
 *   GAP 4, #1141, which the start/stop tests never exercised);
 * - `startTunnel`'s `?? "tunnel"` name fallback for an unknown id (only the stop
 *   path's fallback was covered);
 * - `throwIfRejected`'s `?? \`Failed to …\`` message fallback when a rejected ack
 *   carries no error object;
 * - `errMessage`'s non-Error (`String(err)`) arm, via a raw-string dispatch
 *   rejection (the ack path always wraps its error in an `Error`);
 * - `resolveFirstConnectToasts`' `?? "tunnel"` name and `?? "connection failed"`
 *   detail fallbacks, when the projected error view omits the config/detail.
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

/** A promise that never resolves on its own — keeps an intent "in flight". */
function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function dispatchedKinds(): string[] {
  return dispatchMock.mock.calls.map((call) => (call[0] as { kind: string }).kind);
}

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

describe("tunnelSlice — residual branch coverage (TFE-006)", () => {
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

  describe("reconnectTunnel re-entrancy guard (#1141, reconnect twin)", () => {
    it("no-ops a reconnect while a start for the same tunnel is in flight", async () => {
      useAppStore.setState({ tunnels: [makeTunnel("tun-1", "My Tunnel")] });
      const deferred = makeDeferred<IntentAck>();
      dispatchMock.mockReturnValueOnce(deferred.promise);

      // Start is in flight (its ack pending) → tun-1 is in _tunnelStartInFlight.
      const startFirst = useAppStore.getState().startTunnel("tun-1");
      // A reconnect for the same id must be swallowed by the guard — no dispatch.
      await useAppStore.getState().reconnectTunnel("tun-1");

      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchedKinds()).toEqual(["tunnel.start"]);

      // Let the start settle so the in-flight guard clears, then a reconnect works.
      deferred.resolve(accepted);
      await startFirst;
      await useAppStore.getState().reconnectTunnel("tun-1");
      expect(dispatchedKinds()).toEqual(["tunnel.start", "tunnel.reconnect"]);
    });

    it("no-ops a reconnect while a stop for the same tunnel is in flight", async () => {
      useAppStore.setState({ tunnels: [makeTunnel("tun-2", "Other")] });
      const deferred = makeDeferred<IntentAck>();
      dispatchMock.mockReturnValueOnce(deferred.promise);

      const stopFirst = useAppStore.getState().stopTunnel("tun-2");
      await useAppStore.getState().reconnectTunnel("tun-2");

      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchedKinds()).toEqual(["tunnel.stop"]);

      deferred.resolve(accepted);
      await stopFirst;
    });
  });

  it("startTunnel falls back to the 'tunnel' label for an unknown id", async () => {
    // No matching config in the list → the `?? \"tunnel\"` name fallback fires.
    await useAppStore.getState().startTunnel("ghost");
    expect(toastMock.loading).toHaveBeenCalledWith("Starting tunnel…");
  });

  it("deleteTunnel falls back to the 'tunnel' label for an unknown id", async () => {
    await useAppStore.getState().deleteTunnel("ghost");
    expect(toastMock.loading).toHaveBeenCalledWith("Deleting tunnel…");
    expect(toastMock.success).toHaveBeenCalledWith("Deleted tunnel", { id: "toast-id" });
  });

  it("reconnectTunnel falls back to the 'tunnel' label for an unknown id", async () => {
    await useAppStore.getState().reconnectTunnel("ghost");
    expect(toastMock.loading).toHaveBeenCalledWith("Reconnecting tunnel…");
  });

  it("throwIfRejected uses the generic message when the ack carries no error", async () => {
    // A rejected ack with no `error` object exercises the `?? \`Failed to …\``
    // fallback rather than surfacing a backend-supplied message.
    dispatchMock.mockResolvedValueOnce({
      intentId: "intent-test",
      status: "rejected",
      produced: [],
    });
    await expect(useAppStore.getState().saveTunnel(makeTunnel("t1", "db"))).rejects.toThrow(
      "Failed to save tunnel"
    );
  });

  it("stringifies a non-Error dispatch rejection via the String(err) arm", async () => {
    // The ack path always wraps its error in an `Error`; a raw-string *rejection*
    // of the dispatch promise itself drives `errMessage`'s non-Error branch.
    dispatchMock.mockRejectedValueOnce("raw string failure");
    const logs = await captureLogs(async () => {
      await expect(useAppStore.getState().saveTunnel(makeTunnel("t1", "db"))).rejects.toBe(
        "raw string failure"
      );
    });
    expect(logs.some((m) => m.includes("raw string failure"))).toBe(true);
  });

  it("first-connect error toast falls back to 'tunnel' + 'connection failed' when the view omits them", async () => {
    await useAppStore.getState().loadTunnels();
    const t1 = makeTunnel("t1", "db");
    pushView({ t1: makeState("t1", "disconnected") }, [t1]);

    await useAppStore.getState().startTunnel("t1");
    toastMock.error.mockClear();

    // The failing diff drops the config from `tunnels` (→ name fallback) and omits
    // the `error` detail (→ "connection failed" fallback) — both in one transition.
    pushView({ t1: makeState("t1", "error") }, []);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(toastMock.error.mock.calls[0][0]).toBe("Failed to start tunnel: connection failed");
  });
});
