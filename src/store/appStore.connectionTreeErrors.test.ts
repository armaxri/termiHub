/**
 * Error, rejection, and guard branches of the connection-tree slice
 * (`connectionTreeSlice.ts`) — the paths the happy-path lifecycle tests
 * (`appStore.connectionsMutationCut`, `appStore.connectionMutationAtomicity`,
 * `appStore.feedback`) do not reach: every persist-command rejection (both its
 * `Error.message` and its non-Error `String(err)` guard), the early-return
 * guards (unknown id / same-source / empty batch), and the referential-sweep
 * plural-tunnel toast.
 *
 * These drive the real `appStore` actions against the region harness (the
 * faithful stand-in for the server-side fold) with the `@/services/storage` /
 * `@/services/api` commands mocked to reject, then assert the user-facing
 * feedback (`toast.error` / `toast.info`) and the logged diagnostic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { toastMock } = vi.hoisted(() => ({
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    promise: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/components/ui", () => ({ toast: toastMock }));

// Keep every real frontendLog export intact and spy only on `frontendLog`, so the
// log-only error branch (`reloadConnectionsFromBackend`) can be asserted without
// breaking the many other appStore consumers of this module.
vi.mock("@/utils/frontendLog", async (orig) => ({
  ...(await orig<typeof import("@/utils/frontendLog")>()),
  frontendLog: vi.fn(),
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  reorderConnections: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "./appStore";
import {
  persistConnection,
  removeConnection,
  persistFolder,
  removeFolder,
  reorderConnections as persistConnectionOrder,
  moveConnectionToFile as apiMoveConnectionToFile,
  reloadExternalConnections as apiReloadExternalConnections,
  loadConnections,
} from "@/services/storage";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { frontendLog } from "@/utils/frontendLog";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";
import type { TunnelConfig } from "@/types/tunnel";

setupConnectionsRegion();

const mockLog = vi.mocked(frontendLog);

function makeConnection(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: "conn-1",
    name: "prod-gateway",
    config: { type: "ssh", config: { host: "h", port: 22 } } as never,
    folderId: null,
    ...overrides,
  };
}

function makeFolder(overrides: Partial<ConnectionFolder> = {}): ConnectionFolder {
  return {
    id: "folder-1",
    name: "servers",
    parentId: null,
    isExpanded: true,
    ...overrides,
  };
}

function makeTunnel(id: string, sshConnectionId: string): TunnelConfig {
  return {
    id,
    name: `Tunnel ${id}`,
    sshConnectionId,
    tunnelType: {
      type: "local",
      config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "127.0.0.1", remotePort: 80 },
    },
    autoStart: false,
    reconnectOnDisconnect: false,
  };
}

/** Flush the fire-and-forget persist/remove promise chains. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
});

describe("connectionTree — reloadExternalConnections error branch", () => {
  it("logs + toasts (Error.message) when the reload rejects", async () => {
    vi.mocked(apiReloadExternalConnections).mockRejectedValueOnce(new Error("bad file"));

    await useAppStore.getState().reloadExternalConnections();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to reload external connections: bad file"),
      { id: "reload-external-connections-error" }
    );
    expect(mockLog).toHaveBeenCalledWith(
      "app_store",
      expect.stringContaining("Failed to reload external connections: bad file")
    );
  });

  it("stringifies a non-Error rejection (String(err) branch)", async () => {
    vi.mocked(apiReloadExternalConnections).mockRejectedValueOnce("kaput");

    await useAppStore.getState().reloadExternalConnections();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to reload external connections: kaput"),
      { id: "reload-external-connections-error" }
    );
  });
});

describe("connectionTree — reloadConnectionsFromBackend error branch", () => {
  it("logs the failure (Error.message) when the reload rejects", async () => {
    vi.mocked(loadConnections).mockRejectedValueOnce(new Error("io error"));

    useAppStore.getState().reloadConnectionsFromBackend();
    await flush();

    expect(mockLog).toHaveBeenCalledWith(
      "app_store",
      expect.stringContaining("focus reload failed: io error")
    );
  });

  it("stringifies a non-Error rejection (String(err) branch)", async () => {
    vi.mocked(loadConnections).mockRejectedValueOnce("io string");

    useAppStore.getState().reloadConnectionsFromBackend();
    await flush();

    expect(mockLog).toHaveBeenCalledWith(
      "app_store",
      expect.stringContaining("focus reload failed: io string")
    );
  });
});

describe("connectionTree — toggleFolder guard + error branch", () => {
  it("is a no-op for an unknown folder id (no persist)", () => {
    useAppStore.getState().toggleFolder("does-not-exist");
    expect(vi.mocked(persistFolder)).not.toHaveBeenCalled();
  });

  it("toasts (Error.message) when the folder-toggle persist rejects", async () => {
    seedConnectionsRegion({ folders: [makeFolder()] });
    vi.mocked(persistFolder).mockRejectedValueOnce(new Error("locked"));

    useAppStore.getState().toggleFolder("folder-1");
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save folder state: locked")
    );
  });

  it("stringifies a non-Error rejection on folder toggle (String(err) branch)", async () => {
    seedConnectionsRegion({ folders: [makeFolder()] });
    vi.mocked(persistFolder).mockRejectedValueOnce("locked-str");

    useAppStore.getState().toggleFolder("folder-1");
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save folder state: locked-str")
    );
  });
});

describe("connectionTree — addConnection error branch", () => {
  it("stringifies a non-Error rejection (String(err) branch)", async () => {
    vi.mocked(persistConnection).mockRejectedValueOnce("no space");

    useAppStore.getState().addConnection(makeConnection());
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save prod-gateway: no space")
    );
  });
});

describe("connectionTree — bulkAddConnections guard + toasts", () => {
  it("is a no-op for an empty batch", () => {
    useAppStore.getState().bulkAddConnections([]);
    expect(vi.mocked(persistConnection)).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("uses the singular noun when importing exactly one connection", async () => {
    useAppStore.getState().bulkAddConnections([makeConnection()]);
    await flush();
    expect(toastMock.success).toHaveBeenCalledWith("Imported 1 connection");
  });

  it("toasts an import error (Error.message) when a persist rejects", async () => {
    vi.mocked(persistConnection).mockRejectedValueOnce(new Error("dup"));
    useAppStore
      .getState()
      .bulkAddConnections([makeConnection({ id: "a" }), makeConnection({ id: "b" })]);
    await flush();
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to import connections")
    );
  });

  it("stringifies a non-Error import rejection (String(err) branch)", async () => {
    vi.mocked(persistConnection).mockRejectedValueOnce("dup-str");
    useAppStore.getState().bulkAddConnections([makeConnection({ id: "a" })]);
    await flush();
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to import connections")
    );
  });
});

describe("connectionTree — updateConnection error branch", () => {
  it("stringifies a non-Error rejection (String(err) branch)", async () => {
    seedConnectionsRegion({ connections: [makeConnection()] });
    vi.mocked(persistConnection).mockRejectedValueOnce("read-only");

    useAppStore.getState().updateConnection(makeConnection({ name: "renamed" }));
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save renamed: read-only")
    );
  });
});

describe("connectionTree — deleteConnection guard + error branches", () => {
  it("deletes an id not captured in the region and reports the generic name", async () => {
    // No matching connection in the region → the `conn ?` guard takes its else
    // branch (plain remove, no rollback capture) and the success toast + error
    // toast fall back to "connection" via `conn?.name ?? "connection"`.
    useAppStore.getState().deleteConnection("ghost");
    await flush();

    expect(vi.mocked(removeConnection)).toHaveBeenCalledWith("ghost", undefined);
    expect(toastMock.success).toHaveBeenCalledWith("Deleted connection");
  });

  it("stringifies a non-Error rejection with the generic name (String(err) branch)", async () => {
    vi.mocked(removeConnection).mockRejectedValueOnce("busy");

    useAppStore.getState().deleteConnection("ghost");
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete connection: busy")
    );
  });

  it("warns via toast.info about every tunnel referencing the deleted connection (plural)", async () => {
    seedConnectionsRegion({ connections: [makeConnection()] });
    useAppStore.setState({
      tunnels: [makeTunnel("t1", "conn-1"), makeTunnel("t2", "conn-1")],
    });

    useAppStore.getState().deleteConnection("conn-1");
    await flush();

    expect(toastMock.info).toHaveBeenCalledWith(
      "2 tunnels now reference a deleted SSH connection",
      expect.objectContaining({ description: expect.stringContaining("Tunnel t1") })
    );
  });
});

describe("connectionTree — bulkDeleteConnections error branch", () => {
  it("stringifies a non-Error rejection (String(err) branch)", async () => {
    seedConnectionsRegion({ connections: [makeConnection()] });
    vi.mocked(removeConnection).mockRejectedValueOnce("locked");

    useAppStore.getState().bulkDeleteConnections(["conn-1"]);
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete connections")
    );
  });
});

describe("connectionTree — addFolder error branch", () => {
  it("toasts (Error.message) when the folder persist rejects", async () => {
    vi.mocked(persistFolder).mockRejectedValueOnce(new Error("io"));
    useAppStore.getState().addFolder(makeFolder());
    await flush();
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to create folder servers: io")
    );
  });

  it("stringifies a non-Error rejection (String(err) branch)", async () => {
    vi.mocked(persistFolder).mockRejectedValueOnce("io-str");
    useAppStore.getState().addFolder(makeFolder());
    await flush();
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to create folder servers: io-str")
    );
  });
});

describe("connectionTree — deleteFolder error branch", () => {
  it("toasts (Error.message) when the folder delete rejects", async () => {
    seedConnectionsRegion({ folders: [makeFolder()] });
    vi.mocked(removeFolder).mockRejectedValueOnce(new Error("busy"));
    useAppStore.getState().deleteFolder("folder-1");
    await flush();
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete folder: busy")
    );
  });

  it("stringifies a non-Error rejection (String(err) branch)", async () => {
    seedConnectionsRegion({ folders: [makeFolder()] });
    vi.mocked(removeFolder).mockRejectedValueOnce("busy-str");
    useAppStore.getState().deleteFolder("folder-1");
    await flush();
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete folder: busy-str")
    );
  });
});

describe("connectionTree — duplicateConnection error branch", () => {
  it("stringifies a non-Error rejection (String(err) branch)", async () => {
    seedConnectionsRegion({ connections: [makeConnection()] });
    vi.mocked(persistConnection).mockRejectedValueOnce("no room");

    useAppStore.getState().duplicateConnection("conn-1");
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to duplicate prod-gateway: no room")
    );
  });
});

describe("connectionTree — moveConnectionToFile guards + error branch", () => {
  it("is a no-op for an unknown connection id", async () => {
    await useAppStore.getState().moveConnectionToFile("ghost", "other.json");
    expect(vi.mocked(apiMoveConnectionToFile)).not.toHaveBeenCalled();
  });

  it("is a no-op when the target source equals the current source", async () => {
    // Seeded connection has no `sourceFile` (=> null); moving to null is a no-op.
    seedConnectionsRegion({ connections: [makeConnection()] });
    await useAppStore.getState().moveConnectionToFile("conn-1", null);
    expect(vi.mocked(apiMoveConnectionToFile)).not.toHaveBeenCalled();
  });

  it("toasts (Error.message) when the move rejects", async () => {
    seedConnectionsRegion({ connections: [makeConnection()] });
    vi.mocked(apiMoveConnectionToFile).mockRejectedValueOnce(new Error("denied"));

    await useAppStore.getState().moveConnectionToFile("conn-1", "team.json");

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to move prod-gateway: denied")
    );
  });

  it("stringifies a non-Error rejection (String(err) branch)", async () => {
    seedConnectionsRegion({ connections: [makeConnection()] });
    vi.mocked(apiMoveConnectionToFile).mockRejectedValueOnce("denied-str");

    await useAppStore.getState().moveConnectionToFile("conn-1", "team.json");

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to move prod-gateway: denied-str")
    );
  });
});

describe("connectionTree — moveConnectionToFolder guard + error branch", () => {
  it("is a no-op for an unknown connection id", () => {
    useAppStore.getState().moveConnectionToFolder("ghost", "folder-1");
    expect(vi.mocked(persistConnection)).not.toHaveBeenCalled();
  });

  it("toasts (Error.message) when the move persist rejects", async () => {
    seedConnectionsRegion({ connections: [makeConnection()] });
    vi.mocked(persistConnection).mockRejectedValueOnce(new Error("io"));

    useAppStore.getState().moveConnectionToFolder("conn-1", "folder-1");
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to move prod-gateway: io")
    );
  });

  it("stringifies a non-Error rejection (String(err) branch)", async () => {
    seedConnectionsRegion({ connections: [makeConnection()] });
    vi.mocked(persistConnection).mockRejectedValueOnce("io-str");

    useAppStore.getState().moveConnectionToFolder("conn-1", "folder-1");
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to move prod-gateway: io-str")
    );
  });
});

describe("connectionTree — bulkMoveConnectionsToFolder error branch", () => {
  it("toasts (Error.message) when a move persist rejects", async () => {
    seedConnectionsRegion({ connections: [makeConnection()] });
    vi.mocked(persistConnection).mockRejectedValueOnce(new Error("io"));

    useAppStore.getState().bulkMoveConnectionsToFolder(["conn-1"], "folder-1");
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to move connections")
    );
  });

  it("stringifies a non-Error rejection (String(err) branch)", async () => {
    seedConnectionsRegion({ connections: [makeConnection()] });
    vi.mocked(persistConnection).mockRejectedValueOnce("io-str");

    useAppStore.getState().bulkMoveConnectionsToFolder(["conn-1"], "folder-1");
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to move connections")
    );
  });
});

describe("connectionTree — reorderConnections error branch", () => {
  it("toasts (Error.message) when persisting the new order rejects", async () => {
    seedConnectionsRegion({
      connections: [makeConnection({ id: "a" }), makeConnection({ id: "b" })],
    });
    vi.mocked(persistConnectionOrder).mockRejectedValueOnce(new Error("io"));

    useAppStore.getState().reorderConnections(0, 1);
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save connection order: io")
    );
  });

  it("stringifies a non-Error rejection (String(err) branch)", async () => {
    seedConnectionsRegion({
      connections: [makeConnection({ id: "a" }), makeConnection({ id: "b" })],
    });
    vi.mocked(persistConnectionOrder).mockRejectedValueOnce("io-str");

    useAppStore.getState().reorderConnections(0, 1);
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save connection order: io-str")
    );
  });
});
