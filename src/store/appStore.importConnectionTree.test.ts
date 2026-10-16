/**
 * `importConnectionTree` (#4850, MobaXterm import): imported folders are
 * persisted one after another — parents before children — and only then the
 * connections, so every connection lands in a folder that already exists on
 * disk. A folder failure stops the import before any connection is written.
 * Driven against the faithful {@link ConnectionsBackendDouble}.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { ConnectionsBackendDouble } from "@/test/connectionsBackendDouble";

const backend = vi.hoisted(() => ({ current: null as ConnectionsBackendDouble | null }));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn((...a: [never]) => backend.current!.persistConnection(...a)),
  removeConnection: vi.fn((id: string) => backend.current!.removeConnection(id)),
  persistFolder: vi.fn((...a: [never]) => backend.current!.persistFolder(...a)),
  removeFolder: vi.fn((id: string) => backend.current!.removeFolder(id)),
  reorderConnections: vi.fn((ids: string[]) => backend.current!.reorderConnections(ids)),
  moveConnectionToFile: vi.fn((...a: [string, string | null, string | null]) =>
    backend.current!.moveConnectionToFile(...a)
  ),
  saveConnectionToFile: vi.fn((...a: [never, string | null]) =>
    backend.current!.saveConnectionToFile(...a)
  ),
  persistAgent: vi.fn(() => Promise.resolve()),
  removeAgent: vi.fn(() => Promise.resolve()),
  reorderAgents: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
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
  currentConnectionsView,
  ensureConnectionsSubscribed,
  setConnectionTransportForTest,
  stopConnectionsSubscription,
} from "./connectionsBridge";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";

const DISK = { folders: [] as ConnectionFolder[], connections: [] as SavedConnection[] };

let double: ConnectionsBackendDouble;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function conn(id: string, name: string, folderId: string | null): SavedConnection {
  return { id, name, folderId, config: { type: "ssh", config: { host: "10.0.0.1" } } };
}

const LAB: ConnectionFolder = { id: "Lab", name: "Lab", parentId: null, isExpanded: true };
const SWITCHES: ConnectionFolder = {
  id: "Lab/Switches",
  name: "Switches",
  parentId: "Lab",
  isExpanded: true,
};

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  double = new ConnectionsBackendDouble(DISK);
  backend.current = double;
  setConnectionTransportForTest(double);
  await ensureConnectionsSubscribed();
});

afterEach(() => {
  stopConnectionsSubscription();
  setConnectionTransportForTest(null);
  backend.current = null;
});

describe("importConnectionTree", () => {
  it("persists folders parent-first, then the connections inside them", async () => {
    const order: string[] = [];
    const realFolder = double.persistFolder;
    const realConn = double.persistConnection;
    vi.spyOn(double, "persistFolder").mockImplementation(async (f: ConnectionFolder) => {
      order.push(`folder:${f.id}`);
      await realFolder(f);
    });
    vi.spyOn(double, "persistConnection").mockImplementation(async (c: SavedConnection) => {
      order.push(`conn:${c.name}`);
      return realConn(c);
    });

    await useAppStore
      .getState()
      .importConnectionTree([LAB, SWITCHES], [conn("c1", "sw1", "Lab/Switches")]);
    await settle();

    expect(order).toEqual(["folder:Lab", "folder:Lab/Switches", "conn:sw1"]);
  });

  it("writes the folders and connections to disk", async () => {
    await useAppStore
      .getState()
      .importConnectionTree([LAB], [conn("c1", "router", "Lab"), conn("c2", "box", null)]);
    await settle();

    const disk = double.diskView();
    expect(disk.folders.map((f) => f.id)).toEqual(["Lab"]);
    expect(disk.connections.map((c) => [c.name, c.folderId]).sort()).toEqual([
      ["box", null],
      ["router", "Lab"],
    ]);
    expect(currentConnectionsView().folders.map((f) => f.id)).toEqual(["Lab"]);
  });

  it("stops before any connection when a folder cannot be saved", async () => {
    double.failNext("persistFolder", new Error("disk full"));
    const connSpy = vi.spyOn(double, "persistConnection");

    await useAppStore.getState().importConnectionTree([LAB], [conn("c1", "router", "Lab")]);
    await settle();

    expect(connSpy).not.toHaveBeenCalled();
    expect(double.diskView().connections).toEqual([]);
  });
});
