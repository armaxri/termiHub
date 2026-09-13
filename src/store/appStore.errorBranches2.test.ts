/**
 * Error/guard branch coverage for `appStore.ts` actions — follow-up to TFE-005
 * (PR #2982), tracked by #2983.
 *
 * PR #2982 covered the layout / session-lifecycle / window / workspace-save
 * error branches. This file picks up the deliberately-deferred remainder that
 * is still defined in `appStore.ts` (not the extracted `slices/*`):
 *
 * - Agent-definition CRUD actions — API-rejection + guard branches
 *   (`updateAgentSettings`, `saveAgentDef`, `duplicateAgentDef`, `updateAgentDef`,
 *   `moveAgentDefToFolder`, `createAgentFolder`, `updateAgentFolder`,
 *   `deleteAgentDef`, `deleteAgentFolder`), including the non-`Error`
 *   `String(err)` message path.
 * - `restartPersistentSessionForTab` guard branches (unknown tab, missing
 *   `agentId`, mismatched connection prefix) and the non-fatal attach-failure
 *   branch.
 * - `launchWorkspace` credential-resolution branches (disconnected-agent stored
 *   credential connect, locked-store unlock refusal, per-agent connect failure,
 *   saved-connection credential injection).
 * - `restoreLastSession` `selectedIndices` filtering (empty-selection guard +
 *   the filtered-restore path), mocking the `filterSessionBySelection` Tauri
 *   boundary.
 *
 * These drive `useAppStore` directly with mocked `@/services` APIs, seeded
 * region harnesses, and the mocked restore boundary.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockApplyAgentSettings,
  mockSaveAgentDefinition,
  mockUpdateAgentDefinition,
  mockDeleteAgentDefinition,
  mockCreateAgentFolder,
  mockUpdateAgentFolder,
  mockDeleteAgentFolder,
  mockStartPersistentSession,
  mockAttachPersistentTab,
} = vi.hoisted(() => ({
  mockApplyAgentSettings: vi.fn(() => Promise.resolve()),
  mockSaveAgentDefinition: vi.fn(),
  mockUpdateAgentDefinition: vi.fn(),
  mockDeleteAgentDefinition: vi.fn(() => Promise.resolve()),
  mockCreateAgentFolder: vi.fn(),
  mockUpdateAgentFolder: vi.fn(() => Promise.resolve({})),
  mockDeleteAgentFolder: vi.fn(() => Promise.resolve()),
  mockStartPersistentSession: vi.fn(() => Promise.resolve("session-id")),
  mockAttachPersistentTab: vi.fn(() => Promise.resolve(1)),
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
  applyAgentSettings: mockApplyAgentSettings,
  saveAgentDefinition: mockSaveAgentDefinition,
  updateAgentDefinition: mockUpdateAgentDefinition,
  deleteAgentDefinition: mockDeleteAgentDefinition,
  createAgentFolder: mockCreateAgentFolder,
  updateAgentFolder: mockUpdateAgentFolder,
  deleteAgentFolder: mockDeleteAgentFolder,
  startPersistentSession: mockStartPersistentSession,
  attachPersistentTab: mockAttachPersistentTab,
  connectAgent: vi.fn(() => Promise.resolve({ capabilities: {} })),
  disconnectAgent: vi.fn(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  stopPersistentSession: vi.fn(() => Promise.resolve()),
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  removeCredential: vi.fn(() => Promise.resolve()),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
  sessionGetCapabilities: vi.fn(() => Promise.resolve({})),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/workspaceApi", () => ({
  getWorkspaces: vi.fn(() => Promise.resolve([])),
  loadWorkspace: vi.fn(),
  saveWorkspace: vi.fn(() => Promise.resolve()),
  deleteWorkspace: vi.fn(() => Promise.resolve()),
  duplicateWorkspace: vi.fn(() => Promise.resolve("")),
}));

vi.mock("@/services/lastSessionApi", () => ({
  saveLastSession: vi.fn(() => Promise.resolve()),
  loadLastSession: vi.fn(() => Promise.resolve(null)),
  clearLastSession: vi.fn(() => Promise.resolve()),
}));

// The restore-selection filter reaches the backend over `invoke` (`core`), which
// the global test setup stubs out. Mock the boundary so the empty-selection and
// filtered-restore branches are input-driven.
vi.mock("@/utils/restoreMode", () => ({
  resolveRestoreMode: vi.fn(async () => "ask"),
  summarizeLastSession: vi.fn(async () => ({ tabCount: 0, tabs: [] })),
  filterSessionBySelection: vi.fn(async (session: unknown) => session),
}));

vi.mock("@/utils/resolveConnectionCredential", () => ({
  resolveConnectionCredential: vi.fn(async () => ({
    password: null,
    usedStoredCredential: false,
    credentialType: "password",
  })),
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { useAppStore } from "./appStore";
import { layoutState } from "@/test/layoutState";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { toast } from "@/components/ui";
import { loadWorkspace as apiLoadWorkspace } from "@/services/workspaceApi";
import { loadLastSession as apiLoadLastSession } from "@/services/lastSessionApi";
import { filterSessionBySelection } from "@/utils/restoreMode";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import type { AgentDefinitionInfo, AgentFolderInfo } from "@/services/api";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { RemoteAgentConfig } from "@/types/terminal";
import type { WorkspaceDefinition } from "@/types/workspace";
import type { LastSession } from "@/types/lastSession";

const mockToast = vi.mocked(toast);
const mockLoadWorkspace = vi.mocked(apiLoadWorkspace);
const mockLoadLastSession = vi.mocked(apiLoadLastSession);
const mockFilterSession = vi.mocked(filterSessionBySelection);
const mockResolveCredential = vi.mocked(resolveConnectionCredential);

const AGENT_ID = "agent-1";

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

function knownAgent(
  overrides: Partial<Omit<RemoteAgentDefinition, "config">> & {
    config?: Partial<RemoteAgentConfig>;
  } = {}
): RemoteAgentDefinition {
  const { config, ...rest } = overrides;
  return {
    id: AGENT_ID,
    name: "Agent",
    config: {
      host: "test.local",
      port: 22,
      username: "user",
      authMethod: "password",
      ...config,
    },
    agentSettings: DEFAULT_AGENT_SETTINGS,
    isExpanded: false,
    connectionState: "disconnected",
    ...rest,
  };
}

setupAgentsRegion();
setupConnectionsRegion();

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
});

// ── Agent-definition CRUD — rejection + guard branches ─────────────────────

describe("appStore — agent CRUD error/guard branches (#2983)", () => {
  describe("updateAgentSettings", () => {
    it("propagates the rejection (no swallow) — caller owns feedback", async () => {
      mockApplyAgentSettings.mockRejectedValueOnce(new Error("apply failed"));
      seedAgentsRegion({ remoteAgents: [knownAgent()] });

      await expect(
        useAppStore.getState().updateAgentSettings(AGENT_ID, DEFAULT_AGENT_SETTINGS)
      ).rejects.toThrow("apply failed");
    });
  });

  describe("saveAgentDef", () => {
    it("surfaces an error toast when the save API rejects", async () => {
      mockSaveAgentDefinition.mockRejectedValueOnce(new Error("save boom"));
      seedAgentsRegion({ remoteAgents: [knownAgent()] });

      await useAppStore.getState().saveAgentDef(AGENT_ID, { name: "x" });

      expect(mockToast.error).toHaveBeenCalledTimes(1);
      expect(mockToast.error.mock.calls[0][0]).toMatch(/Failed to save connection: save boom/);
    });

    it("stringifies a non-Error rejection via String(err)", async () => {
      mockSaveAgentDefinition.mockRejectedValueOnce("raw-save-failure");
      seedAgentsRegion({ remoteAgents: [knownAgent()] });

      await useAppStore.getState().saveAgentDef(AGENT_ID, { name: "x" });

      expect(mockToast.error.mock.calls[0][0]).toMatch(/raw-save-failure/);
    });
  });

  describe("duplicateAgentDef", () => {
    it("returns early (no save) when the source definition is not found", async () => {
      seedAgentsRegion({ agentDefinitions: { [AGENT_ID]: [] } });

      await useAppStore.getState().duplicateAgentDef(AGENT_ID, "missing-id");

      expect(mockSaveAgentDefinition).not.toHaveBeenCalled();
    });

    it("delegates to saveAgentDef with a 'Copy of' name for an existing def", async () => {
      const original = makeDefinition({ id: "src", name: "Prod Shell" });
      mockSaveAgentDefinition.mockResolvedValueOnce(makeDefinition({ id: "dup" }));
      seedAgentsRegion({
        remoteAgents: [knownAgent()],
        agentDefinitions: { [AGENT_ID]: [original] },
      });

      await useAppStore.getState().duplicateAgentDef(AGENT_ID, "src");

      expect(mockSaveAgentDefinition).toHaveBeenCalledTimes(1);
      expect(mockSaveAgentDefinition.mock.calls[0][1]).toMatchObject({
        name: "Copy of Prod Shell",
      });
    });
  });

  describe("deleteAgentDef", () => {
    it("surfaces an error toast when the delete API rejects", async () => {
      mockDeleteAgentDefinition.mockRejectedValueOnce(new Error("del boom"));
      seedAgentsRegion({ agentDefinitions: { [AGENT_ID]: [makeDefinition({ id: "d1" })] } });

      await useAppStore.getState().deleteAgentDef(AGENT_ID, "d1");

      expect(mockToast.error.mock.calls[0][0]).toMatch(/Failed to delete connection: del boom/);
    });
  });

  describe("updateAgentDef", () => {
    it("surfaces an error toast when the update API rejects", async () => {
      mockUpdateAgentDefinition.mockRejectedValueOnce(new Error("upd boom"));
      seedAgentsRegion({ agentDefinitions: { [AGENT_ID]: [makeDefinition({ id: "u1" })] } });

      await useAppStore.getState().updateAgentDef(AGENT_ID, { id: "u1", name: "New" });

      expect(mockToast.error.mock.calls[0][0]).toMatch(/Failed to update connection: upd boom/);
    });
  });

  describe("moveAgentDefToFolder", () => {
    it("swallows the failure through updateAgentDef's catch (toast only)", async () => {
      mockUpdateAgentDefinition.mockRejectedValueOnce(new Error("move boom"));
      seedAgentsRegion({ agentDefinitions: { [AGENT_ID]: [makeDefinition({ id: "m1" })] } });

      await useAppStore.getState().moveAgentDefToFolder(AGENT_ID, "m1", "folder-x");

      expect(mockToast.error.mock.calls[0][0]).toMatch(/Failed to update connection: move boom/);
    });
  });

  describe("createAgentFolder", () => {
    it("surfaces an error toast when the create API rejects", async () => {
      mockCreateAgentFolder.mockRejectedValueOnce(new Error("mkdir boom"));
      seedAgentsRegion({ remoteAgents: [knownAgent()], agentFolders: { [AGENT_ID]: [] } });

      await useAppStore.getState().createAgentFolder(AGENT_ID, "New", null);

      expect(mockToast.success).not.toHaveBeenCalled();
      expect(mockToast.error.mock.calls[0][0]).toMatch(/Failed to create folder: mkdir boom/);
    });
  });

  describe("updateAgentFolder", () => {
    it("toasts an error only for a rename (name present) rejection", async () => {
      mockUpdateAgentFolder.mockRejectedValueOnce(new Error("rename boom"));
      seedAgentsRegion({ agentFolders: { [AGENT_ID]: [makeFolder({ id: "f1" })] } });

      await useAppStore.getState().updateAgentFolder(AGENT_ID, { id: "f1", name: "Renamed" });

      expect(mockToast.error.mock.calls[0][0]).toMatch(/Failed to rename folder: rename boom/);
    });

    it("stays silent on a non-rename (bookkeeping) rejection", async () => {
      mockUpdateAgentFolder.mockRejectedValueOnce(new Error("expand boom"));
      seedAgentsRegion({ agentFolders: { [AGENT_ID]: [makeFolder({ id: "f2" })] } });

      await useAppStore.getState().updateAgentFolder(AGENT_ID, { id: "f2", is_expanded: true });

      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it("toasts a success only for a rename (name present) success", async () => {
      mockUpdateAgentFolder.mockResolvedValueOnce({ id: "f3", name: "Done", parentId: null });
      seedAgentsRegion({ agentFolders: { [AGENT_ID]: [makeFolder({ id: "f3" })] } });

      await useAppStore.getState().updateAgentFolder(AGENT_ID, { id: "f3", name: "Done" });

      expect(mockToast.success.mock.calls[0][0]).toMatch(/Renamed folder to Done/);
    });
  });

  describe("deleteAgentFolder", () => {
    it("surfaces an error toast when the delete API rejects", async () => {
      mockDeleteAgentFolder.mockRejectedValueOnce(new Error("rmdir boom"));
      seedAgentsRegion({ agentFolders: { [AGENT_ID]: [makeFolder({ id: "f1" })] } });

      await useAppStore.getState().deleteAgentFolder(AGENT_ID, "f1");

      expect(mockToast.error.mock.calls[0][0]).toMatch(/Failed to delete folder: rmdir boom/);
    });
  });
});

// ── restartPersistentSessionForTab — guard + non-fatal attach branches ─────

describe("appStore — restartPersistentSessionForTab guard/rejection branches (#2983)", () => {
  it("returns null for an unknown tab id", async () => {
    const result = await useAppStore.getState().restartPersistentSessionForTab("no-such-tab");

    expect(result).toBeNull();
    expect(mockStartPersistentSession).not.toHaveBeenCalled();
  });

  it("returns null when the tab config carries no agentId", async () => {
    const tabId = layoutState().addTab(
      "Persistent",
      "remote-session",
      { type: "remote-session", config: { sessionType: "shell" } },
      { contentType: "terminal", persistentConnectionId: "agent-1:def-1" }
    );

    const result = await useAppStore.getState().restartPersistentSessionForTab(tabId);

    expect(result).toBeNull();
    expect(mockStartPersistentSession).not.toHaveBeenCalled();
  });

  it("returns null when the connection id is not prefixed by the agent id", async () => {
    const tabId = layoutState().addTab(
      "Persistent",
      "remote-session",
      { type: "remote-session", config: { agentId: "agent-1", sessionType: "shell" } },
      { contentType: "terminal", persistentConnectionId: "other-agent:def-1" }
    );

    const result = await useAppStore.getState().restartPersistentSessionForTab(tabId);

    expect(result).toBeNull();
    expect(mockStartPersistentSession).not.toHaveBeenCalled();
  });

  it("still returns the session id when the attach call fails (non-fatal)", async () => {
    mockAttachPersistentTab.mockRejectedValueOnce(new Error("attach boom"));
    const tabId = layoutState().addTab(
      "Persistent",
      "remote-session",
      { type: "remote-session", config: { agentId: "agent-1", sessionType: "shell" } },
      { contentType: "terminal", persistentConnectionId: "agent-1:def-1" }
    );
    useAppStore.setState({
      persistentSessions: {
        "agent-1:def-1": {
          connectionId: "agent-1:def-1",
          sessionId: "live-session",
          state: "running",
          attachedTabIds: [],
        },
      },
    });

    const result = await useAppStore.getState().restartPersistentSessionForTab(tabId);

    // Reuse path returns the live session even though the attach bookkeeping failed.
    expect(result).toBe("live-session");
    expect(mockStartPersistentSession).not.toHaveBeenCalled();
  });
});

// ── launchWorkspace — credential-resolution branches ───────────────────────

describe("appStore — launchWorkspace credential-resolution branches (#2983)", () => {
  function agentRefWorkspace(agentId: string): WorkspaceDefinition {
    return {
      id: "ws-agent",
      name: "Agent Workspace",
      tabGroups: [
        {
          name: "Group 1",
          layout: {
            type: "leaf",
            tabs: [
              { agentRef: { agentId, definitionId: "def-1" } },
              { inlineConfig: { type: "shell", config: {} } },
            ],
          },
        },
      ],
    };
  }

  it("resolves a stored credential and connects a disconnected agent before building", async () => {
    mockLoadWorkspace.mockResolvedValueOnce(agentRefWorkspace(AGENT_ID));
    seedAgentsRegion({
      remoteAgents: [
        knownAgent({ connectionState: "disconnected", config: { authMethod: "password" } }),
      ],
    });
    mockResolveCredential.mockResolvedValueOnce({
      password: "s3cret",
      usedStoredCredential: true,
      credentialType: "password",
    });
    const connectSpy = vi.fn(() => Promise.resolve());
    const refreshSpy = vi.fn(() => Promise.resolve());
    useAppStore.setState({ connectRemoteAgent: connectSpy, refreshAgentSessions: refreshSpy });

    await useAppStore.getState().launchWorkspace("ws-agent");

    expect(connectSpy).toHaveBeenCalledWith(AGENT_ID, "s3cret");
    expect(refreshSpy).toHaveBeenCalledWith(AGENT_ID);
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("swallows a per-agent connect failure and still launches the rest", async () => {
    mockLoadWorkspace.mockResolvedValueOnce(agentRefWorkspace(AGENT_ID));
    seedAgentsRegion({
      remoteAgents: [
        knownAgent({ connectionState: "disconnected", config: { authMethod: "password" } }),
      ],
    });
    mockResolveCredential.mockResolvedValueOnce({
      password: "s3cret",
      usedStoredCredential: true,
      credentialType: "password",
    });
    const connectSpy = vi.fn(() => Promise.reject(new Error("connect boom")));
    const refreshSpy = vi.fn(() => Promise.resolve());
    useAppStore.setState({ connectRemoteAgent: connectSpy, refreshAgentSessions: refreshSpy });

    await useAppStore.getState().launchWorkspace("ws-agent");

    // The connect was attempted, its failure was caught, and the agent was NOT
    // added to the just-connected set (so no refresh fired for it).
    expect(connectSpy).toHaveBeenCalledWith(AGENT_ID, "s3cret");
    expect(refreshSpy).not.toHaveBeenCalled();
    // The outer catch (whole-launch failure) did not fire — the launch continued.
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("aborts the launch when the locked store is not unlocked", async () => {
    const workspace: WorkspaceDefinition = {
      id: "ws-locked",
      name: "Locked Workspace",
      tabGroups: [
        {
          name: "Group 1",
          layout: { type: "leaf", tabs: [{ connectionRef: "conn-1" }] },
        },
      ],
    };
    mockLoadWorkspace.mockResolvedValueOnce(workspace);
    seedConnectionsRegion({
      connections: [
        {
          id: "conn-1",
          name: "SSH box",
          config: { type: "ssh", config: { authMethod: "password" } },
          folderId: null,
        },
      ],
    });
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
    });
    const unlockSpy = vi.fn(() => Promise.resolve(false));
    useAppStore.setState({ requestUnlock: unlockSpy });

    await useAppStore.getState().launchWorkspace("ws-locked");

    expect(unlockSpy).toHaveBeenCalledTimes(1);
    // Returned before the per-connection resolution phase.
    expect(mockResolveCredential).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeWorkspaceName).not.toBe("Locked Workspace");
    // Guard cleared in the finally block even on the early return.
    expect(useAppStore.getState().launchingWorkspaceId).toBeNull();
  });

  it("resolves stored credentials for referenced saved connections when unlocked", async () => {
    const workspace: WorkspaceDefinition = {
      id: "ws-conn",
      name: "Conn Workspace",
      tabGroups: [
        {
          name: "Group 1",
          layout: { type: "leaf", tabs: [{ connectionRef: "conn-9" }] },
        },
      ],
    };
    mockLoadWorkspace.mockResolvedValueOnce(workspace);
    seedConnectionsRegion({
      connections: [
        {
          id: "conn-9",
          name: "Saved SSH",
          config: { type: "ssh", config: { authMethod: "password", savePassword: true } },
          folderId: null,
        },
      ],
    });
    useAppStore.setState({
      credentialStoreStatus: { mode: "os_keychain", status: "unlocked" },
    });
    mockResolveCredential.mockResolvedValue({
      password: "injected",
      usedStoredCredential: true,
      credentialType: "password",
    });

    await useAppStore.getState().launchWorkspace("ws-conn");

    expect(mockResolveCredential).toHaveBeenCalledWith("conn-9", "password", true);
  });
});

// ── restoreLastSession — selectedIndices filtering ─────────────────────────

describe("appStore — restoreLastSession selectedIndices filtering (#2983)", () => {
  const storedSession: LastSession = {
    version: "1",
    tabGroups: [{ name: "Group 1", layout: { type: "leaf", tabs: [{ connectionRef: "c1" }] } }],
    activeGroupIndex: 0,
  };

  it("filters the loaded session to the checked indices before building", async () => {
    mockLoadLastSession.mockResolvedValueOnce(storedSession);
    mockFilterSession.mockResolvedValueOnce({
      version: "1",
      tabGroups: [
        {
          name: "Group 1",
          layout: { type: "leaf", tabs: [{ inlineConfig: { type: "shell", config: {} } }] },
        },
      ],
      activeGroupIndex: 0,
    });

    const restored = await useAppStore.getState().restoreLastSession([0]);

    expect(mockFilterSession).toHaveBeenCalledTimes(1);
    expect(mockFilterSession.mock.calls[0][1]).toEqual(new Set([0]));
    expect(restored).toBe(true);
  });

  it("returns false without building when the selection filters everything out", async () => {
    mockLoadLastSession.mockResolvedValueOnce(storedSession);
    mockFilterSession.mockResolvedValueOnce({
      version: "1",
      tabGroups: [],
      activeGroupIndex: 0,
    });

    const restored = await useAppStore.getState().restoreLastSession([]);

    expect(mockFilterSession).toHaveBeenCalledTimes(1);
    expect(restored).toBe(false);
    // No layout replacement, no failure toast — a silent "nothing selected".
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(mockToast.info).not.toHaveBeenCalled();
  });

  it("skips the filter entirely when no selection is passed", async () => {
    mockLoadLastSession.mockResolvedValueOnce(storedSession);

    await useAppStore.getState().restoreLastSession();

    expect(mockFilterSession).not.toHaveBeenCalled();
  });
});
