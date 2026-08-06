import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockConnectAgent,
  mockListAgentSessions,
  mockListAgentConnections,
  mockCreateAgentFolder,
  mockUpdateAgentFolder,
  mockDeleteAgentFolder,
  mockUpdateAgentDefinition,
} = vi.hoisted(() => ({
  mockConnectAgent: vi.fn(),
  mockListAgentSessions: vi.fn(() => Promise.resolve([])),
  mockListAgentConnections: vi.fn(() =>
    Promise.resolve({
      connections: [] as AgentDefinitionInfo[],
      folders: [] as AgentFolderInfo[],
    })
  ),
  mockCreateAgentFolder: vi.fn(),
  mockUpdateAgentFolder: vi.fn(() => Promise.resolve({})),
  mockDeleteAgentFolder: vi.fn(() => Promise.resolve()),
  mockUpdateAgentDefinition: vi.fn(),
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
  disconnectAgent: vi.fn(),
  listAgentSessions: mockListAgentSessions,
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: mockListAgentConnections,
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: mockUpdateAgentDefinition,
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: mockCreateAgentFolder,
  updateAgentFolder: mockUpdateAgentFolder,
  deleteAgentFolder: mockDeleteAgentFolder,
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  removeCredential: vi.fn(() => Promise.resolve()),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "./appStore";
import { currentAgentsView } from "./agentsBridge";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import type { AgentDefinitionInfo, AgentFolderInfo } from "@/services/api";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";

function makeDefinition(overrides: Partial<AgentDefinitionInfo> = {}): AgentDefinitionInfo {
  return {
    id: `conn-${Math.random().toString(36).slice(2, 8)}`,
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

const AGENT_ID = "agent-test-1";

/** A minimal known agent entry so the region's per-agent sub-state ops apply
 * (the store no-ops on an unknown id, matching the Rust `AgentsStore`). */
function knownAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Agent",
    config: { host: "test.local", port: 22, username: "user", authMethod: "password" },
    agentSettings: DEFAULT_AGENT_SETTINGS,
    isExpanded: false,
    connectionState: "disconnected",
    ...overrides,
  };
}

setupAgentsRegion();

describe("appStore — agent connection management", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  describe("toggleAgentFolder", () => {
    it("flips isExpanded for the target folder", () => {
      const folder = makeFolder({ isExpanded: false });
      seedAgentsRegion({
        agentFolders: { [AGENT_ID]: [folder] },
      });

      useAppStore.getState().toggleAgentFolder(AGENT_ID, folder.id);

      const folders = currentAgentsView().agentFolders[AGENT_ID];
      expect(folders[0].isExpanded).toBe(true);
    });

    it("does not affect other folders", () => {
      const folder1 = makeFolder({ id: "f1", isExpanded: false });
      const folder2 = makeFolder({ id: "f2", isExpanded: true });
      seedAgentsRegion({
        agentFolders: { [AGENT_ID]: [folder1, folder2] },
      });

      useAppStore.getState().toggleAgentFolder(AGENT_ID, "f1");

      const folders = currentAgentsView().agentFolders[AGENT_ID];
      expect(folders.find((f) => f.id === "f1")?.isExpanded).toBe(true);
      expect(folders.find((f) => f.id === "f2")?.isExpanded).toBe(true);
    });
  });

  describe("deleteAgentFolder", () => {
    it("removes the folder and moves orphaned connections to root", async () => {
      const folder = makeFolder({ id: "folder-del" });
      const conn1 = makeDefinition({ id: "c1", folderId: "folder-del" });
      const conn2 = makeDefinition({ id: "c2", folderId: null });
      mockDeleteAgentFolder.mockResolvedValue(undefined);

      seedAgentsRegion({
        agentFolders: { [AGENT_ID]: [folder] },
        agentDefinitions: { [AGENT_ID]: [conn1, conn2] },
      });

      await useAppStore.getState().deleteAgentFolder(AGENT_ID, "folder-del");

      const folders = currentAgentsView().agentFolders[AGENT_ID];
      const defs = currentAgentsView().agentDefinitions[AGENT_ID];
      expect(folders).toHaveLength(0);
      expect(defs.find((d) => d.id === "c1")?.folderId).toBeNull();
      expect(defs.find((d) => d.id === "c2")?.folderId).toBeNull();
    });
  });

  describe("refreshAgentSessions", () => {
    it("populates agentDefinitions and agentFolders", async () => {
      const folder = makeFolder({ id: "folder-r" });
      const conn = makeDefinition({ id: "conn-r", folderId: "folder-r" });

      mockListAgentSessions.mockResolvedValue([]);
      mockListAgentConnections.mockResolvedValue({
        connections: [conn],
        folders: [folder],
      });

      // Need a known agent for refreshAgentSessions to apply to the region.
      seedAgentsRegion({
        remoteAgents: [knownAgent()],
        agentSessions: {},
        agentDefinitions: {},
        agentFolders: {},
      });

      await useAppStore.getState().refreshAgentSessions(AGENT_ID);

      expect(currentAgentsView().agentDefinitions[AGENT_ID]).toEqual([conn]);
      expect(currentAgentsView().agentFolders[AGENT_ID]).toEqual([folder]);
    });
  });

  describe("createAgentFolder", () => {
    it("appends the new folder to state", async () => {
      const newFolder = makeFolder({ id: "folder-new", name: "New" });
      mockCreateAgentFolder.mockResolvedValue(newFolder);

      seedAgentsRegion({
        remoteAgents: [knownAgent()],
        agentFolders: { [AGENT_ID]: [] },
      });

      await useAppStore.getState().createAgentFolder(AGENT_ID, "New", null);

      const folders = currentAgentsView().agentFolders[AGENT_ID];
      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe("New");
    });
  });

  describe("updateAgentDef", () => {
    it("updates the matching definition in state", async () => {
      const original = makeDefinition({ id: "conn-upd", name: "Old" });
      const updated = { ...original, name: "New" };
      mockUpdateAgentDefinition.mockResolvedValue(updated);

      seedAgentsRegion({
        agentDefinitions: { [AGENT_ID]: [original] },
      });

      await useAppStore.getState().updateAgentDef(AGENT_ID, { id: "conn-upd", name: "New" });

      const defs = currentAgentsView().agentDefinitions[AGENT_ID];
      expect(defs[0].name).toBe("New");
    });
  });

  describe("bulkMoveAgentDefsToFolder", () => {
    it("moves multiple definitions to a folder in parallel", async () => {
      const def1 = makeDefinition({ id: "c1", folderId: null });
      const def2 = makeDefinition({ id: "c2", folderId: null });
      mockUpdateAgentDefinition
        .mockResolvedValueOnce({ ...def1, folderId: "folder-1" })
        .mockResolvedValueOnce({ ...def2, folderId: "folder-1" });

      seedAgentsRegion({ agentDefinitions: { [AGENT_ID]: [def1, def2] } });

      await useAppStore.getState().bulkMoveAgentDefsToFolder(AGENT_ID, ["c1", "c2"], "folder-1");

      expect(mockUpdateAgentDefinition).toHaveBeenCalledTimes(2);
      const defs = currentAgentsView().agentDefinitions[AGENT_ID];
      expect(defs.find((d) => d.id === "c1")?.folderId).toBe("folder-1");
      expect(defs.find((d) => d.id === "c2")?.folderId).toBe("folder-1");
    });

    it("moves multiple definitions to root", async () => {
      const def1 = makeDefinition({ id: "c1", folderId: "folder-1" });
      const def2 = makeDefinition({ id: "c2", folderId: "folder-1" });
      mockUpdateAgentDefinition
        .mockResolvedValueOnce({ ...def1, folderId: null })
        .mockResolvedValueOnce({ ...def2, folderId: null });

      seedAgentsRegion({ agentDefinitions: { [AGENT_ID]: [def1, def2] } });

      await useAppStore.getState().bulkMoveAgentDefsToFolder(AGENT_ID, ["c1", "c2"], null);

      const defs = currentAgentsView().agentDefinitions[AGENT_ID];
      expect(defs.find((d) => d.id === "c1")?.folderId).toBeNull();
      expect(defs.find((d) => d.id === "c2")?.folderId).toBeNull();
    });
  });

  describe("moveAgentDefToFolder", () => {
    it("moves a definition into a folder", async () => {
      const def = makeDefinition({ id: "conn-move", folderId: null });
      const updated = { ...def, folderId: "folder-1" };
      mockUpdateAgentDefinition.mockResolvedValue(updated);

      seedAgentsRegion({ agentDefinitions: { [AGENT_ID]: [def] } });

      await useAppStore.getState().moveAgentDefToFolder(AGENT_ID, "conn-move", "folder-1");

      expect(mockUpdateAgentDefinition).toHaveBeenCalledWith(AGENT_ID, {
        id: "conn-move",
        folder_id: "folder-1",
      });
      const defs = currentAgentsView().agentDefinitions[AGENT_ID];
      expect(defs.find((d) => d.id === "conn-move")?.folderId).toBe("folder-1");
    });

    it("moves a definition to root when folderId is null", async () => {
      const def = makeDefinition({ id: "conn-root", folderId: "folder-1" });
      const updated = { ...def, folderId: null };
      mockUpdateAgentDefinition.mockResolvedValue(updated);

      seedAgentsRegion({ agentDefinitions: { [AGENT_ID]: [def] } });

      await useAppStore.getState().moveAgentDefToFolder(AGENT_ID, "conn-root", null);

      expect(mockUpdateAgentDefinition).toHaveBeenCalledWith(AGENT_ID, {
        id: "conn-root",
        folder_id: null,
      });
      const defs = currentAgentsView().agentDefinitions[AGENT_ID];
      expect(defs.find((d) => d.id === "conn-root")?.folderId).toBeNull();
    });
  });

  describe("openAgentDefinitionEditorTab", () => {
    it("creates a connection-editor tab with agent definition meta", () => {
      useAppStore.getState().openAgentDefinitionEditorTab(AGENT_ID, "new", "folder-1");

      const { rootPanel } = useAppStore.getState();
      const leaf = rootPanel.type === "leaf" ? rootPanel : null;
      expect(leaf).toBeTruthy();
      const editorTab = leaf!.tabs.find((t) => t.contentType === "connection-editor");
      expect(editorTab).toBeTruthy();
      expect(editorTab!.connectionEditorMeta).toEqual({
        connectionId: AGENT_ID,
        folderId: null,
        agentDefinitionId: "new",
        agentFolderId: "folder-1",
      });
    });

    it("reuses an existing editor tab for the same agent definition", () => {
      useAppStore.getState().openAgentDefinitionEditorTab(AGENT_ID, "def-1");
      useAppStore.getState().openAgentDefinitionEditorTab(AGENT_ID, "def-1");

      const { rootPanel } = useAppStore.getState();
      const leaf = rootPanel.type === "leaf" ? rootPanel : null;
      const editorTabs = leaf!.tabs.filter(
        (t) =>
          t.contentType === "connection-editor" &&
          t.connectionEditorMeta?.agentDefinitionId === "def-1"
      );
      expect(editorTabs).toHaveLength(1);
    });

    it("sets title from existing definition name", () => {
      const def = makeDefinition({ id: "def-title", name: "My Shell" });
      seedAgentsRegion({
        agentDefinitions: { [AGENT_ID]: [def] },
      });

      useAppStore.getState().openAgentDefinitionEditorTab(AGENT_ID, "def-title");

      const { rootPanel } = useAppStore.getState();
      const leaf = rootPanel.type === "leaf" ? rootPanel : null;
      const editorTab = leaf!.tabs.find(
        (t) => t.connectionEditorMeta?.agentDefinitionId === "def-title"
      );
      expect(editorTab!.title).toBe("Edit: My Shell");
    });
  });

  describe("reorderRemoteAgents", () => {
    function makeAgent(id: string, name: string): RemoteAgentDefinition {
      return {
        id,
        name,
        config: {
          host: "test.local",
          port: 22,
          username: "user",
          authMethod: "password",
        },
        isExpanded: false,
        connectionState: "disconnected",
        agentSettings: DEFAULT_AGENT_SETTINGS,
      };
    }

    it("moves an agent from one position to another", () => {
      const agents = [
        makeAgent("a1", "Agent 1"),
        makeAgent("a2", "Agent 2"),
        makeAgent("a3", "Agent 3"),
      ];
      seedAgentsRegion({ remoteAgents: agents });

      useAppStore.getState().reorderRemoteAgents(0, 2);

      const result = currentAgentsView().remoteAgents;
      expect(result.map((a) => a.id)).toEqual(["a2", "a3", "a1"]);
    });

    it("moves an agent backward", () => {
      const agents = [
        makeAgent("a1", "Agent 1"),
        makeAgent("a2", "Agent 2"),
        makeAgent("a3", "Agent 3"),
      ];
      seedAgentsRegion({ remoteAgents: agents });

      useAppStore.getState().reorderRemoteAgents(2, 0);

      const result = currentAgentsView().remoteAgents;
      expect(result.map((a) => a.id)).toEqual(["a3", "a1", "a2"]);
    });

    it("no-ops when indices are the same", () => {
      const agents = [makeAgent("a1", "Agent 1"), makeAgent("a2", "Agent 2")];
      seedAgentsRegion({ remoteAgents: agents });

      useAppStore.getState().reorderRemoteAgents(0, 0);

      const result = currentAgentsView().remoteAgents;
      expect(result.map((a) => a.id)).toEqual(["a1", "a2"]);
    });
  });

  describe("connectRemoteAgent — single-writer connectionState + de-duped refresh (#1234)", () => {
    const CAPS = { connectionTypes: [], maxSessions: 5 };

    function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
      return {
        id: AGENT_ID,
        name: "Test Agent",
        config: {
          host: "test.local",
          port: 22,
          username: "user",
          authMethod: "password",
        },
        isExpanded: false,
        // Simulate the backend already having emitted "connecting" (the single writer).
        connectionState: "connecting",
        agentSettings: DEFAULT_AGENT_SETTINGS,
        ...overrides,
      };
    }

    it("does not clobber an event-written 'reconnecting' state with a late-settling connect", async () => {
      seedAgentsRegion({ remoteAgents: [makeAgent()] });

      // Hold the connect request open so we can interleave a state-change event.
      let resolveConnect!: (value: {
        capabilities: typeof CAPS;
        agentVersion: string;
        protocolVersion: string;
      }) => void;
      mockConnectAgent.mockReturnValue(
        new Promise((res) => {
          resolveConnect = res;
        })
      );

      const connectPromise = useAppStore.getState().connectRemoteAgent(AGENT_ID);

      // A fast drop arrives through the single-writer event while the connect
      // promise is still settling.
      useAppStore.getState().setAgentConnectionState(AGENT_ID, "reconnecting");

      // The connect request now resolves (late).
      resolveConnect({ capabilities: CAPS, agentVersion: "1", protocolVersion: "1" });
      await connectPromise;

      // The late connect must NOT overwrite the event-written "reconnecting".
      expect(currentAgentsView().remoteAgents[0].connectionState).toBe("reconnecting");
    });

    it("consumes capabilities without writing connectionState", async () => {
      seedAgentsRegion({ remoteAgents: [makeAgent()] });
      mockConnectAgent.mockResolvedValue({
        capabilities: CAPS,
        agentVersion: "1",
        protocolVersion: "1",
      });

      await useAppStore.getState().connectRemoteAgent(AGENT_ID);

      const agent = currentAgentsView().remoteAgents[0];
      expect(agent.capabilities).toEqual(CAPS);
      // The action performs no terminal-state write; the event remains authoritative.
      expect(agent.connectionState).toBe("connecting");
    });

    it("does not refresh agent sessions from the connect action (de-duped)", async () => {
      seedAgentsRegion({ remoteAgents: [makeAgent()] });
      mockConnectAgent.mockResolvedValue({
        capabilities: CAPS,
        agentVersion: "1",
        protocolVersion: "1",
      });

      await useAppStore.getState().connectRemoteAgent(AGENT_ID);

      // The refresh is owned by the "connected" event, not the connect action.
      expect(mockListAgentConnections).not.toHaveBeenCalled();
      expect(mockListAgentSessions).not.toHaveBeenCalled();
    });

    it("refreshes agent sessions exactly once when the event writes 'connected'", async () => {
      seedAgentsRegion({ remoteAgents: [makeAgent()] });

      useAppStore.getState().setAgentConnectionState(AGENT_ID, "connected");
      // The refresh is fired fire-and-forget; let its microtasks flush.
      await Promise.resolve();
      await Promise.resolve();

      expect(mockListAgentConnections).toHaveBeenCalledTimes(1);
    });

    it("refreshes only on the transition into 'connected', not on a repeat event", async () => {
      seedAgentsRegion({ remoteAgents: [makeAgent()] });

      useAppStore.getState().setAgentConnectionState(AGENT_ID, "connected");
      useAppStore.getState().setAgentConnectionState(AGENT_ID, "connected");
      await Promise.resolve();
      await Promise.resolve();

      expect(mockListAgentConnections).toHaveBeenCalledTimes(1);
    });
  });

  describe("setAgentConnectionState — lastError (G3, #1236)", () => {
    function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
      return {
        id: AGENT_ID,
        name: "Test Agent",
        config: {
          host: "test.local",
          port: 22,
          username: "user",
          authMethod: "password",
        },
        isExpanded: false,
        connectionState: "connected",
        agentSettings: DEFAULT_AGENT_SETTINGS,
        ...overrides,
      };
    }

    it("stores lastError when transitioning to 'disconnected' with an error", () => {
      seedAgentsRegion({ remoteAgents: [makeAgent({ connectionState: "reconnecting" })] });

      useAppStore
        .getState()
        .setAgentConnectionState(AGENT_ID, "disconnected", "Failed to reconnect after 10 attempts");

      const agent = currentAgentsView().remoteAgents[0];
      expect(agent.connectionState).toBe("disconnected");
      expect(agent.lastError).toBe("Failed to reconnect after 10 attempts");
    });

    it("leaves lastError unset when 'disconnected' arrives without an error", () => {
      seedAgentsRegion({ remoteAgents: [makeAgent({ connectionState: "connected" })] });

      useAppStore.getState().setAgentConnectionState(AGENT_ID, "disconnected");

      const agent = currentAgentsView().remoteAgents[0];
      expect(agent.connectionState).toBe("disconnected");
      expect(agent.lastError).toBeUndefined();
    });

    it("clears a stored lastError on the next 'connecting' attempt", () => {
      seedAgentsRegion({
        remoteAgents: [makeAgent({ connectionState: "disconnected", lastError: "old failure" })],
      });

      useAppStore.getState().setAgentConnectionState(AGENT_ID, "connecting");

      const agent = currentAgentsView().remoteAgents[0];
      expect(agent.connectionState).toBe("connecting");
      expect(agent.lastError).toBeUndefined();
    });

    it("clears a stored lastError once the agent reaches 'connected'", () => {
      seedAgentsRegion({
        remoteAgents: [makeAgent({ connectionState: "reconnecting", lastError: "old failure" })],
      });

      useAppStore.getState().setAgentConnectionState(AGENT_ID, "connected");

      const agent = currentAgentsView().remoteAgents[0];
      expect(agent.connectionState).toBe("connected");
      expect(agent.lastError).toBeUndefined();
    });
  });

  describe("clearAgentSessions", () => {
    it("empties agentSessions for the given agent", () => {
      seedAgentsRegion({
        remoteAgents: [knownAgent()],
        agentSessions: {
          [AGENT_ID]: [
            { sessionId: "s1", title: "shell", type: "shell", status: "running", attached: false },
          ],
        },
      });

      useAppStore.getState().clearAgentSessions(AGENT_ID);

      expect(currentAgentsView().agentSessions[AGENT_ID]).toEqual([]);
    });

    it("does not clear definitions or folders", () => {
      const def = makeDefinition({ id: "d1" });
      const folder = makeFolder({ id: "f1" });
      seedAgentsRegion({
        remoteAgents: [knownAgent()],
        agentSessions: {
          [AGENT_ID]: [
            { sessionId: "s1", title: "shell", type: "shell", status: "running", attached: false },
          ],
        },
        agentDefinitions: { [AGENT_ID]: [def] },
        agentFolders: { [AGENT_ID]: [folder] },
      });

      useAppStore.getState().clearAgentSessions(AGENT_ID);

      expect(currentAgentsView().agentSessions[AGENT_ID]).toEqual([]);
      expect(currentAgentsView().agentDefinitions[AGENT_ID]).toEqual([def]);
      expect(currentAgentsView().agentFolders[AGENT_ID]).toEqual([folder]);
    });

    it("does not affect other agents", () => {
      seedAgentsRegion({
        remoteAgents: [knownAgent(), knownAgent({ id: "other-agent" })],
        agentSessions: {
          [AGENT_ID]: [
            { sessionId: "s1", title: "shell", type: "shell", status: "running", attached: false },
          ],
          "other-agent": [
            { sessionId: "s2", title: "shell", type: "shell", status: "running", attached: false },
          ],
        },
      });

      useAppStore.getState().clearAgentSessions(AGENT_ID);

      expect(currentAgentsView().agentSessions[AGENT_ID]).toEqual([]);
      expect(currentAgentsView().agentSessions["other-agent"]).toHaveLength(1);
    });
  });
});
