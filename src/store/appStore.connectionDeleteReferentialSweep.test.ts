/**
 * Referential-integrity sweep on connection delete (FES-009).
 *
 * `deleteConnection` / `bulkDeleteConnections` remove the entity from the
 * `connections` region and persist the deletion, but several pieces of state are
 * keyed off the connection id and used to be left dangling once the connection
 * was gone:
 *
 * - `persistentSessions[connectionId]` — a live background session kept its entry
 *   (an orphan reconnect target / badge for a connection that no longer exists).
 * - open tabs' `connectionId` / `persistentConnectionId` — pointed at a removed
 *   entity.
 * - SSH tunnels' `sshConnectionId` — a tunnel whose SSH connection was deleted
 *   became silently unresolvable.
 *
 * These tests drive the real `appStore` delete actions against the same faithful
 * in-memory port of the Rust `ConnectionsStore` the FES-005 atomicity tests use,
 * then assert no dangling references remain — and, critically, that the
 * (irreversible) persistent-session teardown runs ONLY after the delete is
 * confirmed durable, so a rejected persist (region rolled back, FES-005) never
 * tears down a session for a connection that is coming back.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mockStopPersistentSession, toastMock } = vi.hoisted(() => ({
  mockStopPersistentSession: vi.fn().mockResolvedValue(undefined),
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    promise: vi.fn(),
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
  persistAgent: vi.fn(() => Promise.resolve()),
  removeAgent: vi.fn(() => Promise.resolve()),
  reorderAgents: vi.fn(() => Promise.resolve()),
  reorderConnections: vi.fn(() => Promise.resolve()),
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
  startPersistentSession: vi.fn().mockResolvedValue("mock-session-id"),
  stopPersistentSession: mockStopPersistentSession,
  attachPersistentTab: vi.fn().mockResolvedValue(1),
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: toastMock };
});

import { useAppStore } from "./appStore";
import { removeConnection } from "@/services/storage";
import {
  currentConnectionsView,
  ensureConnectionsSubscribed,
  setConnectionTransportForTest,
  stopConnectionsSubscription,
} from "./connectionsBridge";
import type { ConnectionFolder, SavedConnection, PersistentSessionEntry } from "@/types/connection";
import type { TabContent } from "@/types/terminal";
import type { TunnelConfig } from "@/types/tunnel";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

function makeConnection(id: string): SavedConnection {
  return {
    id,
    name: `Conn ${id}`,
    config: { type: "ssh", config: { host: `h-${id}`, port: 22 } } as never,
    folderId: null,
  };
}

function makeTabContent(id: string, refs: Partial<TabContent>): TabContent {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "h", port: 22 } } as never,
    ...refs,
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

interface RegionView {
  folders: ConnectionFolder[];
  connections: SavedConnection[];
}

/** Faithful in-memory port of the Rust `ConnectionsStore` (the FES-005 double). */
class ConnectionsStoreTransport implements Transport {
  private folders: ConnectionFolder[] = [];
  private connections: SavedConnection[] = [];
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    const p = intent.payload as Record<string, unknown>;
    switch (intent.kind) {
      case "connection.add":
        this.connections.push(structuredClone(p.connection as SavedConnection));
        break;
      case "connection.remove":
        this.connections = this.connections.filter((c) => c.id !== (p.connectionId as string));
        break;
      default:
        break;
    }
    this.version += 1;
    this.fan();
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: "connections", version: this.version }],
    };
  }

  private regionView(): RegionView {
    return structuredClone({ folders: this.folders, connections: this.connections });
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.push(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== onFrame);
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: this.regionView() };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot("connections");
    for (const h of this.handlers) h(frame);
  }
}

let transport: ConnectionsStoreTransport;

function ids(): string[] {
  return currentConnectionsView().connections.map((c) => c.id);
}

function seedDependents(connectionId: string): void {
  useAppStore.setState({
    persistentSessions: {
      [connectionId]: {
        connectionId,
        sessionId: "live-session",
        state: "running",
        attachedTabIds: ["tab-persistent"],
      } satisfies PersistentSessionEntry,
    },
    tabContent: {
      "tab-from-conn": makeTabContent("tab-from-conn", { connectionId }),
      "tab-persistent": makeTabContent("tab-persistent", { persistentConnectionId: connectionId }),
      "tab-other": makeTabContent("tab-other", { connectionId: "other-conn" }),
    },
    tunnels: [makeTunnel("tun-1", connectionId), makeTunnel("tun-2", "other-conn")],
  });
}

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  transport = new ConnectionsStoreTransport();
  setConnectionTransportForTest(transport);
  await ensureConnectionsSubscribed();
});

afterEach(() => {
  stopConnectionsSubscription();
  setConnectionTransportForTest(null);
});

describe("connection delete sweeps dependent state (FES-009)", () => {
  it("deleteConnection tears down the persistent session, clears dangling tab refs, and surfaces orphaned tunnels", async () => {
    useAppStore.getState().addConnection(makeConnection("ssh-1"));
    expect(ids()).toEqual(["ssh-1"]);
    seedDependents("ssh-1");

    useAppStore.getState().deleteConnection("ssh-1");

    // Persistent session: torn down via the normal path, then its entry dropped.
    await vi.waitFor(() => {
      expect(useAppStore.getState().persistentSessions["ssh-1"]).toBeUndefined();
    });
    expect(mockStopPersistentSession).toHaveBeenCalledWith("ssh-1");

    // Open tabs: the dangling references are cleared; the tabs themselves survive.
    const content = useAppStore.getState().tabContent;
    expect(content["tab-from-conn"]).toBeDefined();
    expect(content["tab-from-conn"].connectionId).toBeUndefined();
    expect(content["tab-persistent"]).toBeDefined();
    expect(content["tab-persistent"].persistentConnectionId).toBeUndefined();
    // A tab keyed off a different connection is untouched.
    expect(content["tab-other"].connectionId).toBe("other-conn");

    // Tunnels: the one referencing the deleted connection is surfaced (not silently
    // rotted); the unrelated tunnel is left alone.
    expect(toastMock.info).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().tunnels).toHaveLength(2);
  });

  it("does NOT tear down the persistent session when the delete persist rejects (FES-005 ordering)", async () => {
    useAppStore.getState().addConnection(makeConnection("ssh-1"));
    seedDependents("ssh-1");

    // The on-disk delete fails: the region rolls the removal back (the connection
    // reappears), so the sweep must not have irreversibly torn down its session.
    vi.mocked(removeConnection).mockRejectedValueOnce(new Error("disk read-only"));

    useAppStore.getState().deleteConnection("ssh-1");

    await vi.waitFor(() => expect(ids()).toEqual(["ssh-1"]));
    // Give any (wrongly-fired) sweep a chance to run, then assert nothing was swept.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockStopPersistentSession).not.toHaveBeenCalled();
    expect(useAppStore.getState().persistentSessions["ssh-1"]).toBeDefined();
    expect(useAppStore.getState().tabContent["tab-from-conn"].connectionId).toBe("ssh-1");
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it("bulkDeleteConnections sweeps each successfully-deleted connection's references", async () => {
    useAppStore.getState().addConnection(makeConnection("ssh-1"));
    useAppStore.getState().addConnection(makeConnection("ssh-2"));
    expect(ids()).toEqual(["ssh-1", "ssh-2"]);

    useAppStore.setState({
      persistentSessions: {
        "ssh-1": {
          connectionId: "ssh-1",
          sessionId: "s1",
          state: "running",
          attachedTabIds: [],
        } satisfies PersistentSessionEntry,
        "ssh-2": {
          connectionId: "ssh-2",
          sessionId: "s2",
          state: "running",
          attachedTabIds: [],
        } satisfies PersistentSessionEntry,
      },
      tabContent: {
        "tab-1": makeTabContent("tab-1", { connectionId: "ssh-1" }),
        "tab-2": makeTabContent("tab-2", { connectionId: "ssh-2" }),
      },
      tunnels: [makeTunnel("tun-1", "ssh-1")],
    });

    useAppStore.getState().bulkDeleteConnections(["ssh-1", "ssh-2"]);

    await vi.waitFor(() => {
      expect(useAppStore.getState().persistentSessions["ssh-1"]).toBeUndefined();
      expect(useAppStore.getState().persistentSessions["ssh-2"]).toBeUndefined();
    });
    expect(mockStopPersistentSession).toHaveBeenCalledWith("ssh-1");
    expect(mockStopPersistentSession).toHaveBeenCalledWith("ssh-2");
    const content = useAppStore.getState().tabContent;
    expect(content["tab-1"].connectionId).toBeUndefined();
    expect(content["tab-2"].connectionId).toBeUndefined();
  });

  it("bulkDeleteConnections does NOT sweep an item whose persist rejected", async () => {
    useAppStore.getState().addConnection(makeConnection("ssh-1"));
    useAppStore.getState().addConnection(makeConnection("ssh-2"));

    useAppStore.setState({
      persistentSessions: {
        "ssh-1": {
          connectionId: "ssh-1",
          sessionId: "s1",
          state: "running",
          attachedTabIds: [],
        } satisfies PersistentSessionEntry,
        "ssh-2": {
          connectionId: "ssh-2",
          sessionId: "s2",
          state: "running",
          attachedTabIds: [],
        } satisfies PersistentSessionEntry,
      },
    });

    // Only "ssh-2" fails on disk; "ssh-1" deletes cleanly.
    vi.mocked(removeConnection).mockImplementation((id: string) =>
      id === "ssh-2" ? Promise.reject(new Error("locked")) : Promise.resolve()
    );

    useAppStore.getState().bulkDeleteConnections(["ssh-1", "ssh-2"]);

    // "ssh-2" reappears (its persist failed) and keeps its session; "ssh-1" is swept.
    await vi.waitFor(() => expect(ids()).toEqual(["ssh-2"]));
    await new Promise((r) => setTimeout(r, 10));
    expect(useAppStore.getState().persistentSessions["ssh-1"]).toBeUndefined();
    expect(useAppStore.getState().persistentSessions["ssh-2"]).toBeDefined();
    expect(mockStopPersistentSession).toHaveBeenCalledWith("ssh-1");
    expect(mockStopPersistentSession).not.toHaveBeenCalledWith("ssh-2");
  });
});
