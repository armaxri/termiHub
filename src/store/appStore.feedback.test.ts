import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the toast hub so we can assert feedback without real DOM toasts.
const toastSuccess = vi.fn((_message: unknown, _opts?: unknown) => undefined);
const toastError = vi.fn((_message: unknown, _opts?: unknown) => undefined);
const toastLoading = vi.fn((_message: unknown, _opts?: unknown) => "toast-id");
vi.mock("@/components/ui", () => ({
  toast: {
    success: (message: unknown, opts?: unknown) =>
      opts === undefined ? toastSuccess(message) : toastSuccess(message, opts),
    error: (message: unknown, opts?: unknown) =>
      opts === undefined ? toastError(message) : toastError(message, opts),
    loading: (message: unknown, opts?: unknown) =>
      opts === undefined ? toastLoading(message) : toastLoading(message, opts),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve("persisted-id")),
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

import { useAppStore } from "./appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { persistConnection, removeConnection } from "@/services/storage";
import type { SavedConnection } from "@/types/connection";

setupConnectionsRegion();

function makeConnection(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: "prod-gateway",
    config: { type: "local", config: { shell: "bash" } },
    folderId: null,
    ...overrides,
  };
}

/** Flush the fire-and-forget persist/remove promise chains. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("appStore — CRUD feedback wiring", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    vi.mocked(persistConnection).mockResolvedValue("persisted-id");
    vi.mocked(removeConnection).mockResolvedValue(undefined);
  });

  it("addConnection emits a success toast naming the connection", async () => {
    useAppStore.getState().addConnection(makeConnection({ name: "prod-gateway" }));
    await flush();
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("prod-gateway"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("addConnection emits an error toast when persistence fails", async () => {
    vi.mocked(persistConnection).mockRejectedValueOnce(new Error("disk full"));
    useAppStore.getState().addConnection(makeConnection({ name: "prod-gateway" }));
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("prod-gateway"));
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });

  it("deleteConnection emits a success toast on backend confirm", async () => {
    const conn = makeConnection({ name: "old-box" });
    seedConnectionsRegion({ connections: [conn] });
    useAppStore.getState().deleteConnection(conn.id);
    await flush();
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("old-box"));
  });

  it("deleteConnection emits an error toast when the backend rejects", async () => {
    vi.mocked(removeConnection).mockRejectedValueOnce(new Error("locked"));
    const conn = makeConnection({ name: "old-box" });
    seedConnectionsRegion({ connections: [conn] });
    useAppStore.getState().deleteConnection(conn.id);
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("old-box"));
  });
});
