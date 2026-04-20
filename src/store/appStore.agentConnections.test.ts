import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockListAgentSessions,
  mockListAgentConnections,
  mockCreateAgentFolder,
  mockUpdateAgentFolder,
  mockDeleteAgentFolder,
  mockUpdateAgentDefinition,
} = vi.hoisted(() => ({
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
  connectAgent: vi.fn(),
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

describe("appStore — agent connection management", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  describe("toggleAgentFolder", () => {
    it("flips isExpanded for the target folder", () => {
      const folder = makeFolder({ isExpanded: false });
      useAppStore.setState({
        agentFolders: { [AGENT_ID]: [folder] },
      });

      useAppStore.getState().toggleAgentFolder(AGENT_ID, folder.id);

      const folders = useAppStore.getState().agentFolders[AGENT_ID];
      expect(folders[0].isExpanded).toBe(true);
    });

    it("does not affect other folders", () => {
      const folder1 = makeFolder({ id: "f1", isExpanded: false });
      const folder2 = makeFolder({ id: "f2", isExpanded: true });
      useAppStore.setState({
        agentFolders: { [AGENT_ID]: [folder1, folder2] },
      });

      useAppStore.getState().toggleAgentFolder(AGENT_ID, "f1");

      const folders = useAppStore.getState().agentFolders[AGENT_ID];
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

      useAppStore.setState({
        agentFolders: { [AGENT_ID]: [folder] },
        agentDefinitions: { [AGENT_ID]: [conn1, conn2] },
      });

      await useAppStore.getState().deleteAgentFolder(AGENT_ID, "folder-del");

      const folders = useAppStore.getState().agentFolders[AGENT_ID];
      const defs = useAppStore.getState().agentDefinitions[AGENT_ID];
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

      // Need a connected agent for refreshAgentSessions to be meaningful
      useAppStore.setState({
        agentSessions: {},
        agentDefinitions: {},
        agentFolders: {},
      });

      await useAppStore.getState().refreshAgentSessions(AGENT_ID);

      expect(useAppStore.getState().agentDefinitions[AGENT_ID]).toEqual([conn]);
      expect(useAppStore.getState().agentFolders[AGENT_ID]).toEqual([folder]);
    });
  });

  describe("createAgentFolder", () => {
    it("appends the new folder to state", async () => {
      const newFolder = makeFolder({ id: "folder-new", name: "New" });
      mockCreateAgentFolder.mockResolvedValue(newFolder);

      useAppStore.setState({
        agentFolders: { [AGENT_ID]: [] },
      });

      await useAppStore.getState().createAgentFolder(AGENT_ID, "New", null);

      const folders = useAppStore.getState().agentFolders[AGENT_ID];
      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe("New");
    });
  });

  describe("updateAgentDef", () => {
    it("updates the matching definition in state", async () => {
      const original = makeDefinition({ id: "conn-upd", name: "Old" });
      const updated = { ...original, name: "New" };
      mockUpdateAgentDefinition.mockResolvedValue(updated);

      useAppStore.setState({
        agentDefinitions: { [AGENT_ID]: [original] },
      });

      await useAppStore.getState().updateAgentDef(AGENT_ID, { id: "conn-upd", name: "New" });

      const defs = useAppStore.getState().agentDefinitions[AGENT_ID];
      expect(defs[0].name).toBe("New");
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
      useAppStore.setState({
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
      useAppStore.setState({ remoteAgents: agents });

      useAppStore.getState().reorderRemoteAgents(0, 2);

      const result = useAppStore.getState().remoteAgents;
      expect(result.map((a) => a.id)).toEqual(["a2", "a3", "a1"]);
    });

    it("moves an agent backward", () => {
      const agents = [
        makeAgent("a1", "Agent 1"),
        makeAgent("a2", "Agent 2"),
        makeAgent("a3", "Agent 3"),
      ];
      useAppStore.setState({ remoteAgents: agents });

      useAppStore.getState().reorderRemoteAgents(2, 0);

      const result = useAppStore.getState().remoteAgents;
      expect(result.map((a) => a.id)).toEqual(["a3", "a1", "a2"]);
    });

    it("no-ops when indices are the same", () => {
      const agents = [makeAgent("a1", "Agent 1"), makeAgent("a2", "Agent 2")];
      useAppStore.setState({ remoteAgents: agents });

      useAppStore.getState().reorderRemoteAgents(0, 0);

      const result = useAppStore.getState().remoteAgents;
      expect(result.map((a) => a.id)).toEqual(["a1", "a2"]);
    });
  });

  describe("clearAgentSessions", () => {
    it("empties agentSessions for the given agent", () => {
      useAppStore.setState({
        agentSessions: {
          [AGENT_ID]: [
            { sessionId: "s1", title: "shell", type: "shell", status: "running", attached: false },
          ],
        },
      });

      useAppStore.getState().clearAgentSessions(AGENT_ID);

      expect(useAppStore.getState().agentSessions[AGENT_ID]).toEqual([]);
    });

    it("does not clear definitions or folders", () => {
      const def = makeDefinition({ id: "d1" });
      const folder = makeFolder({ id: "f1" });
      useAppStore.setState({
        agentSessions: {
          [AGENT_ID]: [
            { sessionId: "s1", title: "shell", type: "shell", status: "running", attached: false },
          ],
        },
        agentDefinitions: { [AGENT_ID]: [def] },
        agentFolders: { [AGENT_ID]: [folder] },
      });

      useAppStore.getState().clearAgentSessions(AGENT_ID);

      expect(useAppStore.getState().agentSessions[AGENT_ID]).toEqual([]);
      expect(useAppStore.getState().agentDefinitions[AGENT_ID]).toEqual([def]);
      expect(useAppStore.getState().agentFolders[AGENT_ID]).toEqual([folder]);
    });

    it("does not affect other agents", () => {
      useAppStore.setState({
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

      expect(useAppStore.getState().agentSessions[AGENT_ID]).toEqual([]);
      expect(useAppStore.getState().agentSessions["other-agent"]).toHaveLength(1);
    });
  });
});
