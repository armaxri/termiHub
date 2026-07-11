/**
 * Regression tests for #1427.
 *
 * The store's `deleteEmbeddedServer` previously swallowed backend errors with a
 * bare `console.error` and resolved as if the delete had succeeded. That hid the
 * failure from the caller, so the error toast added to `EmbeddedServerSidebar`
 * in #1393 never fired on a real backend delete failure. These tests pin that
 * the action now propagates the backend error to the caller (reject/throw) and
 * keeps the server in the store on failure — mirroring `deleteTunnel`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the service modules the store imports at module load. We only care about
// embeddedServerApi here, but the store pulls in the full graph.
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

vi.mock("@/services/embeddedServerApi", () => ({
  listEmbeddedServers: vi.fn(() => Promise.resolve([])),
  saveEmbeddedServer: vi.fn(() => Promise.resolve()),
  deleteEmbeddedServer: vi.fn(() => Promise.resolve()),
  startEmbeddedServer: vi.fn(() => Promise.resolve()),
  stopEmbeddedServer: vi.fn(() => Promise.resolve()),
  getEmbeddedServerStates: vi.fn(() => Promise.resolve([])),
  createAndStartServer: vi.fn(() => Promise.resolve("srv-1")),
  listNetworkInterfaces: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "./appStore";
import { deleteEmbeddedServer as apiDeleteEmbeddedServer } from "@/services/embeddedServerApi";
import type { EmbeddedServerConfig, ServerState } from "@/types/embeddedServer";

function makeServer(id: string, name: string): EmbeddedServerConfig {
  return {
    id,
    name,
    serverType: "http",
    rootDirectory: "/tmp",
    bindHost: "127.0.0.1",
    port: 8080,
    autoStart: false,
    readOnly: false,
    directoryListing: true,
  };
}

function runningState(id: string): ServerState {
  return {
    serverId: id,
    status: "running",
    stats: { activeConnections: 0, totalConnections: 0, bytesSent: 0, bytesReceived: 0 },
  };
}

describe("appStore — deleteEmbeddedServer error propagation (#1427)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({
      embeddedServers: [makeServer("srv-1", "Share")],
      embeddedServerStates: { "srv-1": runningState("srv-1") },
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("removes the server from the store on a successful delete", async () => {
    await useAppStore.getState().deleteEmbeddedServer("srv-1");

    expect(apiDeleteEmbeddedServer).toHaveBeenCalledWith("srv-1");
    expect(useAppStore.getState().embeddedServers).toHaveLength(0);
    expect(useAppStore.getState().embeddedServerStates["srv-1"]).toBeUndefined();
  });

  it("rejects and keeps the server when the backend delete fails", async () => {
    vi.mocked(apiDeleteEmbeddedServer).mockRejectedValueOnce(new Error("boom"));

    // The failure must surface to the caller (so the sidebar's error toast can
    // fire) instead of being swallowed to console.error.
    await expect(useAppStore.getState().deleteEmbeddedServer("srv-1")).rejects.toThrow("boom");

    // On failure the server must NOT be optimistically removed (no desync).
    expect(useAppStore.getState().embeddedServers).toHaveLength(1);
    expect(useAppStore.getState().embeddedServerStates["srv-1"]).toBeDefined();
  });
});
