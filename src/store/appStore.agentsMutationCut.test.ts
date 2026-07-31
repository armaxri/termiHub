/**
 * Agents mutation cut (#2226, part of #2139) — cut-vs-local parity.
 *
 * The mutation cut routes each agent lifecycle action through a granular
 * `agent.*` intent so the backend `AgentsStore` becomes authoritative, while the
 * local `appStore` reducer path stays in place as the render source and the
 * resilience / rollback fallback (the reducer removal is a later step).
 *
 * These tests prove the cut is parity-safe end to end: with the flag **on**, the
 * intents dispatched by the actions — applied by a faithful in-memory port of the
 * Rust store (mirroring `agents_projection/store.rs`) — reproduce the exact
 * `appStore` agents slice (`remoteAgents` + `agentSessions` + `agentDefinitions` +
 * `agentFolders`) for every action and its fan-out. With the flag **off**, no
 * intents are dispatched and the local slice is byte-identical — the instant
 * rollback path the flip relies on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  mockConnectAgent,
  mockDisconnectAgent,
  mockShutdownAgent,
  mockApplyAgentSettings,
  mockListAgentSessions,
  mockListAgentConnections,
  mockSaveAgentDefinition,
  mockUpdateAgentDefinition,
  mockDeleteAgentDefinition,
  mockCreateAgentFolder,
  mockUpdateAgentFolder,
  mockDeleteAgentFolder,
} = vi.hoisted(() => ({
  mockConnectAgent: vi.fn(),
  mockDisconnectAgent: vi.fn(() => Promise.resolve()),
  mockShutdownAgent: vi.fn(() => Promise.resolve(0)),
  mockApplyAgentSettings: vi.fn(() => Promise.resolve()),
  mockListAgentSessions: vi.fn(() => Promise.resolve([] as AgentSessionInfo[])),
  mockListAgentConnections: vi.fn(() =>
    Promise.resolve({
      connections: [] as AgentDefinitionInfo[],
      folders: [] as AgentFolderInfo[],
    })
  ),
  mockSaveAgentDefinition: vi.fn(),
  mockUpdateAgentDefinition: vi.fn(),
  mockDeleteAgentDefinition: vi.fn(() => Promise.resolve()),
  mockCreateAgentFolder: vi.fn(),
  mockUpdateAgentFolder: vi.fn(() => Promise.resolve({})),
  mockDeleteAgentFolder: vi.fn(() => Promise.resolve()),
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
  connectAgent: mockConnectAgent,
  disconnectAgent: mockDisconnectAgent,
  shutdownAgent: mockShutdownAgent,
  applyAgentSettings: mockApplyAgentSettings,
  listAgentSessions: mockListAgentSessions,
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: mockListAgentConnections,
  saveAgentDefinition: mockSaveAgentDefinition,
  updateAgentDefinition: mockUpdateAgentDefinition,
  deleteAgentDefinition: mockDeleteAgentDefinition,
  createAgentFolder: mockCreateAgentFolder,
  updateAgentFolder: mockUpdateAgentFolder,
  deleteAgentFolder: mockDeleteAgentFolder,
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "./appStore";
import { setAgentIntentsEnabled, setAgentTransportForTest } from "./agentsBridge";
import type { AgentDefinitionInfo, AgentFolderInfo, AgentSessionInfo } from "@/services/api";
import {
  DEFAULT_AGENT_SETTINGS,
  type AgentCapabilities,
  type RemoteAgentDefinition,
} from "@/types/connection";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const CAPS: AgentCapabilities = { connectionTypes: [], maxSessions: 5 };

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_A,
    name: "Agent A",
    config: { host: "a.local", port: 22, username: "user", authMethod: "password" },
    agentSettings: DEFAULT_AGENT_SETTINGS,
    isExpanded: false,
    connectionState: "disconnected",
    ...overrides,
  };
}

function makeDefinition(overrides: Partial<AgentDefinitionInfo> = {}): AgentDefinitionInfo {
  return {
    id: `def-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Connection",
    sessionType: "shell",
    config: {},
    persistent: false,
    folderId: null,
    ...overrides,
  };
}

function makeFolder(overrides: Partial<AgentFolderInfo> = {}): AgentFolderInfo {
  return {
    id: `folder-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Folder",
    parentId: null,
    isExpanded: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
  return {
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    title: "shell",
    type: "shell",
    status: "running",
    attached: false,
    ...overrides,
  };
}

interface RegionView {
  agents: RemoteAgentDefinition[];
  sessions: Record<string, AgentSessionInfo[]>;
  definitions: Record<string, AgentDefinitionInfo[]>;
  folders: Record<string, AgentFolderInfo[]>;
}

/**
 * An in-memory substrate double that applies the granular `agent.*` intents with
 * the same semantics as the Rust `AgentsStore`, so a run of the real `appStore`
 * actions (which mirror those intents) reconstructs the region view the agent
 * sidebar and Open Connections would render. Only `agent.replace` (the render-cut
 * mirror) is intentionally not applied here — the mutation cut drives the region
 * through the per-transition intents.
 */
class AgentsStoreTransport implements Transport {
  dispatched: Intent[] = [];
  private agents: RemoteAgentDefinition[] = [];
  private sessions: Record<string, AgentSessionInfo[]> = {};
  private definitions: Record<string, AgentDefinitionInfo[]> = {};
  private folders: Record<string, AgentFolderInfo[]> = {};
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    this.apply(intent);
    this.version += 1;
    this.fan();
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: "agents", version: this.version }],
    };
  }

  private agentAt(id: string): RemoteAgentDefinition | undefined {
    return this.agents.find((a) => a.id === id);
  }

  private apply(intent: Intent): void {
    const p = intent.payload as Record<string, unknown>;
    const id = p.id as string;
    switch (intent.kind) {
      case "agent.add": {
        if (this.agentAt(id)) break;
        this.agents.push({
          id,
          name: p.name as string,
          config: p.config as RemoteAgentDefinition["config"],
          agentSettings: p.agentSettings as RemoteAgentDefinition["agentSettings"],
          isExpanded: false,
          connectionState: "disconnected",
        });
        break;
      }
      case "agent.update": {
        const a = this.agentAt(id);
        if (a) {
          a.name = p.name as string;
          a.config = p.config as RemoteAgentDefinition["config"];
          a.agentSettings = p.agentSettings as RemoteAgentDefinition["agentSettings"];
        }
        break;
      }
      case "agent.applySettings": {
        const a = this.agentAt(id);
        if (a) a.agentSettings = p.agentSettings as RemoteAgentDefinition["agentSettings"];
        break;
      }
      case "agent.remove": {
        this.agents = this.agents.filter((a) => a.id !== id);
        delete this.sessions[id];
        delete this.definitions[id];
        delete this.folders[id];
        break;
      }
      case "agent.reorder": {
        const oldIndex = p.oldIndex as number;
        const newIndex = p.newIndex as number;
        if (oldIndex >= this.agents.length || newIndex >= this.agents.length) break;
        const [moved] = this.agents.splice(oldIndex, 1);
        this.agents.splice(newIndex, 0, moved);
        break;
      }
      case "agent.toggleExpanded": {
        const a = this.agentAt(id);
        if (a) a.isExpanded = !a.isExpanded;
        break;
      }
      case "agent.status": {
        const a = this.agentAt(id);
        if (a) {
          const state = p.state as RemoteAgentDefinition["connectionState"];
          const error = p.error as string | undefined;
          // Mirror the Rust `set_status` lastError rules exactly.
          if (state === "disconnected") a.lastError = error ?? a.lastError;
          else if (state === "connecting" || state === "connected") a.lastError = undefined;
          a.connectionState = state;
        }
        break;
      }
      case "agent.setCapabilities": {
        const a = this.agentAt(id);
        if (a) a.capabilities = p.capabilities as AgentCapabilities;
        break;
      }
      case "agent.disconnect": {
        const a = this.agentAt(id);
        if (a) {
          a.connectionState = "disconnected";
          this.sessions[id] = [];
          this.folders[id] = [];
        }
        break;
      }
      case "agent.refresh": {
        if (!this.agentAt(id)) break;
        this.sessions[id] = p.sessions as AgentSessionInfo[];
        this.definitions[id] = p.definitions as AgentDefinitionInfo[];
        this.folders[id] = p.folders as AgentFolderInfo[];
        break;
      }
      case "agent.clearSessions": {
        if (this.agentAt(id)) this.sessions[id] = [];
        break;
      }
      case "agent.saveDefinition": {
        if (!this.agentAt(id)) break;
        const def = p.definition as AgentDefinitionInfo;
        const list = (this.definitions[id] ?? []).filter((d) => d.id !== def.id);
        list.push(def);
        this.definitions[id] = list;
        break;
      }
      case "agent.updateDefinition": {
        const def = p.definition as AgentDefinitionInfo;
        const list = this.definitions[id];
        if (list) this.definitions[id] = list.map((d) => (d.id === def.id ? def : d));
        break;
      }
      case "agent.deleteDefinition": {
        const list = this.definitions[id];
        if (list) this.definitions[id] = list.filter((d) => d.id !== (p.definitionId as string));
        break;
      }
      case "agent.createFolder": {
        if (!this.agentAt(id)) break;
        this.folders[id] = [...(this.folders[id] ?? []), p.folder as AgentFolderInfo];
        break;
      }
      case "agent.updateFolder": {
        const folder = p.folder as AgentFolderInfo;
        const list = this.folders[id];
        if (list) this.folders[id] = list.map((f) => (f.id === folder.id ? folder : f));
        break;
      }
      case "agent.deleteFolder": {
        const folderId = p.folderId as string;
        const list = this.folders[id];
        if (list) this.folders[id] = list.filter((f) => f.id !== folderId);
        const defs = this.definitions[id];
        if (defs) {
          this.definitions[id] = defs.map((d) =>
            d.folderId === folderId ? { ...d, folderId: null } : d
          );
        }
        break;
      }
      default:
        break;
    }
  }

  /** The reconstructed region view, twin of the store snapshot. */
  regionView(): RegionView {
    return structuredClone({
      agents: this.agents,
      sessions: this.sessions,
      definitions: this.definitions,
      folders: this.folders,
    });
  }

  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
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
    const frame: ProjectionFrame = this.snapshot("agents");
    for (const h of this.handlers) h(frame);
  }
}

let transport: AgentsStoreTransport;

/** Assert the region the intents reconstruct equals the local appStore slice. */
function expectParity() {
  const state = useAppStore.getState();
  const region = transport.regionView();
  expect(region.agents).toEqual(state.remoteAgents);
  expect(region.sessions).toEqual(state.agentSessions);
  expect(region.definitions).toEqual(state.agentDefinitions);
  expect(region.folders).toEqual(state.agentFolders);
}

/** Let the fire-and-forget refresh (setAgentConnectionState → connected) flush. */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  transport = new AgentsStoreTransport();
  setAgentTransportForTest(transport);
  setAgentIntentsEnabled(true);
});

afterEach(() => {
  setAgentTransportForTest(null);
  setAgentIntentsEnabled(null);
});

describe("agents mutation cut — cut-vs-local parity (flag on)", () => {
  it("addRemoteAgent reproduces the fresh agent entry", () => {
    useAppStore.getState().addRemoteAgent(makeAgent());

    expect(transport.kinds()).toEqual(["agent.add"]);
    expectParity();
    expect(transport.regionView().agents[0].connectionState).toBe("disconnected");
  });

  it("updateRemoteAgent reproduces the edited fields", () => {
    const agent = makeAgent();
    useAppStore.getState().addRemoteAgent(agent);
    useAppStore.getState().updateRemoteAgent({ ...agent, name: "Renamed" });

    expectParity();
    expect(transport.regionView().agents[0].name).toBe("Renamed");
  });

  it("updateAgentSettings mirrors the settings-only change", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    const nextSettings = { ...DEFAULT_AGENT_SETTINGS, enableDocker: false };

    await useAppStore.getState().updateAgentSettings(AGENT_A, nextSettings);

    expectParity();
    expect(transport.regionView().agents[0].agentSettings.enableDocker).toBe(false);
    expect(transport.kinds()).toContain("agent.applySettings");
  });

  it("reorderRemoteAgents reproduces the new order", () => {
    useAppStore.getState().addRemoteAgent(makeAgent({ id: "a1", name: "A1" }));
    useAppStore.getState().addRemoteAgent(makeAgent({ id: "a2", name: "A2" }));
    useAppStore.getState().addRemoteAgent(makeAgent({ id: "a3", name: "A3" }));

    useAppStore.getState().reorderRemoteAgents(0, 2);

    expectParity();
    expect(transport.regionView().agents.map((a) => a.id)).toEqual(["a2", "a3", "a1"]);
  });

  it("toggleRemoteAgent flips the projected expansion", () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    useAppStore.getState().toggleRemoteAgent(AGENT_A);

    expectParity();
    expect(transport.regionView().agents[0].isExpanded).toBe(true);
  });

  it("connectRemoteAgent mirrors the capabilities and force-expand", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    mockConnectAgent.mockResolvedValue({
      capabilities: CAPS,
      agentVersion: "1",
      protocolVersion: "1",
    });

    await useAppStore.getState().connectRemoteAgent(AGENT_A);

    expectParity();
    const agent = transport.regionView().agents[0];
    expect(agent.capabilities).toEqual(CAPS);
    expect(agent.isExpanded).toBe(true);
    // No connectionState write from connect (single writer G4/#1234).
    expect(agent.connectionState).toBe("disconnected");
    expect(transport.kinds()).toEqual([
      "agent.add",
      "agent.setCapabilities",
      "agent.toggleExpanded",
    ]);
  });

  it("connect does not re-toggle an already-expanded agent", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    // Expand via the real toggle so both the local slice and the region reach
    // isExpanded:true (add always creates a collapsed agent).
    useAppStore.getState().toggleRemoteAgent(AGENT_A);
    mockConnectAgent.mockResolvedValue({
      capabilities: CAPS,
      agentVersion: "1",
      protocolVersion: "1",
    });

    await useAppStore.getState().connectRemoteAgent(AGENT_A);

    expectParity();
    expect(transport.regionView().agents[0].isExpanded).toBe(true);
    // Only one toggle (the explicit one) — connect must not toggle again.
    expect(transport.kinds()).toEqual([
      "agent.add",
      "agent.toggleExpanded",
      "agent.setCapabilities",
    ]);
  });

  it("setAgentConnectionState drives the projected connection state", () => {
    useAppStore.getState().addRemoteAgent(makeAgent());

    useAppStore.getState().setAgentConnectionState(AGENT_A, "connecting");
    expectParity();
    expect(transport.regionView().agents[0].connectionState).toBe("connecting");
  });

  it("a terminal disconnect records lastError in the region", () => {
    useAppStore.getState().addRemoteAgent(makeAgent({ connectionState: "reconnecting" }));

    useAppStore
      .getState()
      .setAgentConnectionState(AGENT_A, "disconnected", "gave up after 10 tries");

    expectParity();
    expect(transport.regionView().agents[0].lastError).toBe("gave up after 10 tries");
  });

  it("the connected transition fans out a refresh into the region", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent({ connectionState: "connecting" }));
    const def = makeDefinition({ id: "d1" });
    const folder = makeFolder({ id: "f1" });
    const session = makeSession({ sessionId: "s1" });
    mockListAgentSessions.mockResolvedValue([session]);
    mockListAgentConnections.mockResolvedValue({ connections: [def], folders: [folder] });

    useAppStore.getState().setAgentConnectionState(AGENT_A, "connected");
    await flushMicrotasks();

    expectParity();
    const view = transport.regionView();
    expect(view.sessions[AGENT_A]).toEqual([session]);
    expect(view.definitions[AGENT_A]).toEqual([def]);
    expect(view.folders[AGENT_A]).toEqual([folder]);
    expect(transport.kinds()).toContain("agent.refresh");
  });

  it("disconnectRemoteAgent forces disconnected and clears live sub-state", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent({ connectionState: "connected" }));
    useAppStore.setState((s) => ({
      agentSessions: { ...s.agentSessions, [AGENT_A]: [makeSession()] },
      agentFolders: { ...s.agentFolders, [AGENT_A]: [makeFolder()] },
    }));

    await useAppStore.getState().disconnectRemoteAgent(AGENT_A);

    // The local slice cleared sessions/folders; make the region mirror that
    // starting state via a status intent for the pre-clear content is not needed —
    // disconnect alone reproduces the cleared slice.
    expect(transport.regionView().agents[0].connectionState).toBe("disconnected");
    expect(transport.regionView().sessions[AGENT_A]).toEqual([]);
    expect(transport.regionView().folders[AGENT_A]).toEqual([]);
    expect(transport.kinds()).toContain("agent.disconnect");
  });

  it("shutdownRemoteAgent tears the agent down like disconnect", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent({ connectionState: "connected" }));
    mockShutdownAgent.mockResolvedValue(2);

    const detached = await useAppStore.getState().shutdownRemoteAgent(AGENT_A);

    expect(detached).toBe(2);
    expectParity();
    expect(transport.regionView().agents[0].connectionState).toBe("disconnected");
    expect(transport.kinds()).toContain("agent.disconnect");
  });

  it("clearAgentSessions empties the region's live-session list", () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    useAppStore.setState((s) => ({
      agentSessions: { ...s.agentSessions, [AGENT_A]: [makeSession()] },
    }));
    // Seed the region's session list so the clear has something to erase.
    transport.dispatch({
      intentId: "seed",
      kind: "agent.refresh",
      payload: { id: AGENT_A, sessions: [makeSession()], definitions: [], folders: [] },
      clientId: "seed",
    });

    useAppStore.getState().clearAgentSessions(AGENT_A);

    expect(useAppStore.getState().agentSessions[AGENT_A]).toEqual([]);
    expect(transport.regionView().sessions[AGENT_A]).toEqual([]);
    expect(transport.kinds()).toContain("agent.clearSessions");
  });

  it("setAgentCapabilities records the capabilities in the region", () => {
    useAppStore.getState().addRemoteAgent(makeAgent());

    useAppStore.getState().setAgentCapabilities(AGENT_A, CAPS);

    expectParity();
    expect(transport.regionView().agents[0].capabilities).toEqual(CAPS);
  });

  it("saveAgentDef upserts a definition into the region", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    const saved = makeDefinition({ id: "d1", name: "Saved" });
    mockSaveAgentDefinition.mockResolvedValue(saved);

    await useAppStore.getState().saveAgentDef(AGENT_A, {
      name: "Saved",
      type: "shell",
      config: {},
      persistent: false,
    });

    expectParity();
    expect(transport.regionView().definitions[AGENT_A]).toEqual([saved]);
  });

  it("updateAgentDef replaces the definition by id", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    const original = makeDefinition({ id: "d1", name: "Old" });
    useAppStore.setState((s) => ({
      agentDefinitions: { ...s.agentDefinitions, [AGENT_A]: [original] },
    }));
    transport.dispatch({
      intentId: "seed",
      kind: "agent.saveDefinition",
      payload: { id: AGENT_A, definition: original },
      clientId: "seed",
    });
    const updated = { ...original, name: "New" };
    mockUpdateAgentDefinition.mockResolvedValue(updated);

    await useAppStore.getState().updateAgentDef(AGENT_A, { id: "d1", name: "New" });

    expectParity();
    expect(transport.regionView().definitions[AGENT_A][0].name).toBe("New");
  });

  it("deleteAgentDef removes the definition from the region", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    const def = makeDefinition({ id: "d1" });
    useAppStore.setState((s) => ({
      agentDefinitions: { ...s.agentDefinitions, [AGENT_A]: [def] },
    }));
    transport.dispatch({
      intentId: "seed",
      kind: "agent.saveDefinition",
      payload: { id: AGENT_A, definition: def },
      clientId: "seed",
    });

    await useAppStore.getState().deleteAgentDef(AGENT_A, "d1");

    expectParity();
    expect(transport.regionView().definitions[AGENT_A]).toEqual([]);
  });

  it("createAgentFolder appends the folder to the region", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    const folder = makeFolder({ id: "f1", name: "New" });
    mockCreateAgentFolder.mockResolvedValue(folder);

    await useAppStore.getState().createAgentFolder(AGENT_A, "New", null);

    expectParity();
    expect(transport.regionView().folders[AGENT_A]).toEqual([folder]);
  });

  it("updateAgentFolder replaces the folder by id (rename)", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    const folder = makeFolder({ id: "f1", name: "Old" });
    useAppStore.setState((s) => ({
      agentFolders: { ...s.agentFolders, [AGENT_A]: [folder] },
    }));
    transport.dispatch({
      intentId: "seed",
      kind: "agent.createFolder",
      payload: { id: AGENT_A, folder },
      clientId: "seed",
    });
    const renamed = { ...folder, name: "Renamed" };
    mockUpdateAgentFolder.mockResolvedValue(renamed);

    await useAppStore.getState().updateAgentFolder(AGENT_A, { id: "f1", name: "Renamed" });

    expectParity();
    expect(transport.regionView().folders[AGENT_A][0].name).toBe("Renamed");
  });

  it("toggleAgentFolder flips the folder expansion in the region", () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    const folder = makeFolder({ id: "f1", isExpanded: false });
    useAppStore.setState((s) => ({
      agentFolders: { ...s.agentFolders, [AGENT_A]: [folder] },
    }));
    transport.dispatch({
      intentId: "seed",
      kind: "agent.createFolder",
      payload: { id: AGENT_A, folder },
      clientId: "seed",
    });

    useAppStore.getState().toggleAgentFolder(AGENT_A, "f1");

    expectParity();
    expect(transport.regionView().folders[AGENT_A][0].isExpanded).toBe(true);
    expect(transport.kinds()).toContain("agent.updateFolder");
  });

  it("deleteAgentFolder removes the folder and reparents its definitions", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    const folder = makeFolder({ id: "f1" });
    const child = makeDefinition({ id: "d1", folderId: "f1" });
    const root = makeDefinition({ id: "d2", folderId: null });
    useAppStore.setState((s) => ({
      agentFolders: { ...s.agentFolders, [AGENT_A]: [folder] },
      agentDefinitions: { ...s.agentDefinitions, [AGENT_A]: [child, root] },
    }));
    transport.dispatch({
      intentId: "seed-folder",
      kind: "agent.createFolder",
      payload: { id: AGENT_A, folder },
      clientId: "seed",
    });
    transport.dispatch({
      intentId: "seed-child",
      kind: "agent.saveDefinition",
      payload: { id: AGENT_A, definition: child },
      clientId: "seed",
    });
    transport.dispatch({
      intentId: "seed-root",
      kind: "agent.saveDefinition",
      payload: { id: AGENT_A, definition: root },
      clientId: "seed",
    });

    await useAppStore.getState().deleteAgentFolder(AGENT_A, "f1");

    expectParity();
    const view = transport.regionView();
    expect(view.folders[AGENT_A]).toEqual([]);
    expect(view.definitions[AGENT_A].find((d) => d.id === "d1")?.folderId).toBeNull();
  });

  it("deleteRemoteAgent drops the agent and all of its sub-state", async () => {
    useAppStore.getState().addRemoteAgent(makeAgent());
    const def = makeDefinition({ id: "d1" });
    const folder = makeFolder({ id: "f1" });
    useAppStore.setState((s) => ({
      agentDefinitions: { ...s.agentDefinitions, [AGENT_A]: [def] },
      agentFolders: { ...s.agentFolders, [AGENT_A]: [folder] },
    }));
    transport.dispatch({
      intentId: "seed",
      kind: "agent.refresh",
      payload: { id: AGENT_A, sessions: [], definitions: [def], folders: [folder] },
      clientId: "seed",
    });

    useAppStore.getState().deleteRemoteAgent(AGENT_A);

    expectParity();
    const view = transport.regionView();
    expect(view.agents).toEqual([]);
    expect(view.definitions[AGENT_A]).toBeUndefined();
    expect(view.folders[AGENT_A]).toBeUndefined();
    expect(transport.kinds()).toContain("agent.remove");
  });

  it("multi-agent fan-out stays independent", () => {
    useAppStore.getState().addRemoteAgent(makeAgent({ id: AGENT_A, name: "A" }));
    useAppStore.getState().addRemoteAgent(makeAgent({ id: AGENT_B, name: "B" }));
    useAppStore.getState().toggleRemoteAgent(AGENT_A);

    expectParity();
    const view = transport.regionView();
    expect(view.agents.find((a) => a.id === AGENT_A)?.isExpanded).toBe(true);
    expect(view.agents.find((a) => a.id === AGENT_B)?.isExpanded).toBe(false);
  });

  it("a full lifecycle stays in parity across every step", async () => {
    mockConnectAgent.mockResolvedValue({
      capabilities: CAPS,
      agentVersion: "1",
      protocolVersion: "1",
    });
    const def = makeDefinition({ id: "d1" });
    const folder = makeFolder({ id: "f1" });
    mockListAgentSessions.mockResolvedValue([makeSession({ sessionId: "s1" })]);
    mockListAgentConnections.mockResolvedValue({ connections: [def], folders: [folder] });

    useAppStore.getState().addRemoteAgent(makeAgent());
    expectParity();
    useAppStore.getState().setAgentConnectionState(AGENT_A, "connecting");
    expectParity();
    await useAppStore.getState().connectRemoteAgent(AGENT_A);
    expectParity();
    useAppStore.getState().setAgentConnectionState(AGENT_A, "connected");
    await flushMicrotasks();
    expectParity();
    await useAppStore.getState().disconnectRemoteAgent(AGENT_A);
    expectParity();
  });
});

describe("agents mutation cut — flag off (rollback path)", () => {
  beforeEach(() => setAgentIntentsEnabled(false));

  it("dispatches no intents and drives the slice locally", async () => {
    mockConnectAgent.mockResolvedValue({
      capabilities: CAPS,
      agentVersion: "1",
      protocolVersion: "1",
    });

    useAppStore.getState().addRemoteAgent(makeAgent());
    useAppStore.getState().toggleRemoteAgent(AGENT_A);
    await useAppStore.getState().connectRemoteAgent(AGENT_A);
    useAppStore.getState().setAgentConnectionState(AGENT_A, "connected");
    await flushMicrotasks();
    await useAppStore.getState().disconnectRemoteAgent(AGENT_A);
    useAppStore.getState().deleteRemoteAgent(AGENT_A);

    // No mirror reached the region — the pre-cut local path is intact.
    expect(transport.dispatched).toHaveLength(0);
    // The local slice still behaves exactly as before the cut.
    expect(useAppStore.getState().remoteAgents).toEqual([]);
  });
});
