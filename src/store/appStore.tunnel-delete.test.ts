/**
 * Regression tests for GAP 7 from the SSH tunnel audit (#1141), carried across
 * the projection migration (#2150).
 *
 * The store's `deleteTunnel` previously swallowed errors with a bare
 * `console.error` and gave no user feedback on success or failure (violating
 * design-system rule 4: every action gives feedback). These tests pin that
 * deleting a tunnel emits a loading→success toast on success and a
 * loading→error toast on failure, mirroring the existing start/stop pattern.
 *
 * Post-#2150 the delete is a `tunnel.remove` intent over the projection
 * transport; the actual row removal is driven by the resulting projection diff
 * (asserted in `tunnelSlice.projection.test.ts`), so on failure the row must NOT
 * be optimistically removed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { IntentAck } from "@/services/transport";

const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));

// Mock the service modules the store imports at module load. We only care about
// the projection transport + the toast primitive here, but the store pulls in
// the full graph.
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
    onChange() {
      return () => {};
    }
    async start() {}
    stop() {}
  },
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
import { toast } from "@/components/ui";
import type { TunnelConfig } from "@/types/tunnel";

const ACCEPTED: IntentAck = { intentId: "intent-test", status: "accepted", produced: [] };

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

describe("appStore — deleteTunnel feedback (GAP 7, #1141)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ tunnels: [makeTunnel("tun-1", "My Tunnel")] });
    vi.clearAllMocks();
    dispatchMock.mockResolvedValue(ACCEPTED);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches a tunnel.remove intent with loading then success toast", async () => {
    await useAppStore.getState().deleteTunnel("tun-1");

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0][0]).toMatchObject({
      kind: "tunnel.remove",
      payload: { id: "tun-1" },
    });
    expect(toast.loading).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("My Tunnel"),
      expect.objectContaining({ id: "toast-id" })
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows an error toast and keeps the tunnel when the intent is rejected", async () => {
    dispatchMock.mockResolvedValueOnce({
      intentId: "intent-test",
      status: "rejected",
      error: { code: "delete_failed", message: "boom" },
    });

    await expect(useAppStore.getState().deleteTunnel("tun-1")).rejects.toThrow("boom");

    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    // On failure the row must NOT be optimistically removed (no desync — the
    // projection diff is the only thing that mutates the list).
    expect(useAppStore.getState().tunnels).toHaveLength(1);
  });
});
