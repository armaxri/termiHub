/**
 * Regression tests for GAP 7 from the SSH tunnel audit (#1141).
 *
 * The store's `deleteTunnel` previously swallowed errors with a bare
 * `console.error` and gave no user feedback on success or failure (violating
 * design-system rule 4: every action gives feedback). These tests pin that
 * deleting a tunnel emits a loading→success toast on success and a
 * loading→error toast on failure, mirroring the existing start/stop pattern.
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
import { deleteTunnel as apiDeleteTunnel } from "@/services/tunnelApi";
import { toast } from "@/components/ui";
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

describe("appStore — deleteTunnel feedback (GAP 7, #1141)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ tunnels: [makeTunnel("tun-1", "My Tunnel")] });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading then success toast when a tunnel is deleted", async () => {
    await useAppStore.getState().deleteTunnel("tun-1");

    expect(toast.loading).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("My Tunnel"),
      expect.objectContaining({ id: "toast-id" })
    );
    expect(toast.error).not.toHaveBeenCalled();
    // The tunnel is removed from the store on success.
    expect(useAppStore.getState().tunnels).toHaveLength(0);
  });

  it("shows an error toast and keeps the tunnel when deletion fails", async () => {
    vi.mocked(apiDeleteTunnel).mockRejectedValueOnce(new Error("boom"));

    await expect(useAppStore.getState().deleteTunnel("tun-1")).rejects.toThrow("boom");

    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    // On failure the row must NOT be optimistically removed (no desync).
    expect(useAppStore.getState().tunnels).toHaveLength(1);
  });
});
