import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Regression suite for #1472 — no user-initiated mutating action dispatched
 * from appStore should resolve silently. Each test rejects the underlying
 * persist/command and asserts a recoverable `toast.error` fires (rather than
 * the failure being swallowed by a bare `console.error`).
 */

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
  persistAgent: vi.fn(() => Promise.resolve()),
  removeAgent: vi.fn(() => Promise.resolve()),
  reorderAgents: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
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
  disconnectAgent: vi.fn(() => Promise.resolve()),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(() => Promise.resolve({})),
  updateAgentDefinition: vi.fn(() => Promise.resolve({})),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(() => Promise.resolve({})),
  updateAgentFolder: vi.fn(() => Promise.resolve({})),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/workspaceApi", () => ({
  getWorkspaces: vi.fn(() => Promise.resolve([])),
  loadWorkspace: vi.fn(() => Promise.resolve({})),
  saveWorkspace: vi.fn(() => Promise.resolve()),
  deleteWorkspace: vi.fn(() => Promise.resolve()),
  duplicateWorkspace: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/lastSessionApi", () => ({
  saveLastSession: vi.fn(() => Promise.resolve()),
  loadLastSession: vi.fn(() => Promise.resolve(null)),
  clearLastSession: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "./appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import {
  persistConnection,
  removeConnection,
  persistFolder,
  removeFolder,
  persistAgent,
  removeAgent,
  reorderAgents,
  moveConnectionToFile,
} from "@/services/storage";
import {
  disconnectAgent,
  listAgentSessions,
  saveAgentDefinition,
  updateAgentDefinition,
  deleteAgentDefinition,
  deleteAgentFolder,
} from "@/services/api";
import { duplicateWorkspace } from "@/services/workspaceApi";
import { saveLastSession, clearLastSession } from "@/services/lastSessionApi";
import type { SavedConnection, ConnectionFolder, RemoteAgentDefinition } from "@/types/connection";
import { DEFAULT_AGENT_SETTINGS } from "@/types/connection";

function makeConnection(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: `conn-${Math.random().toString(36).slice(2, 8)}`,
    name: "prod-gateway",
    config: { type: "local", config: { shell: "bash" } },
    folderId: null,
    ...overrides,
  };
}

function makeFolder(overrides: Partial<ConnectionFolder> = {}): ConnectionFolder {
  return {
    id: `folder-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Folder",
    parentId: null,
    isExpanded: false,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Agent",
    config: { host: "test.local", port: 22, username: "user", authMethod: "password" },
    isExpanded: false,
    connectionState: "disconnected",
    agentSettings: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

/** Flush the fire-and-forget persist/remove promise chains. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const AGENT_ID = "agent-test-1";

setupConnectionsRegion();
setupAgentsRegion();

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
});

describe("#1472 — connection mutating actions surface errors", () => {
  it("bulkDeleteConnections toasts on a rejected removal", async () => {
    vi.mocked(removeConnection).mockRejectedValueOnce(new Error("locked"));
    const conn = makeConnection();
    seedConnectionsRegion({ connections: [conn] });
    useAppStore.getState().bulkDeleteConnections([conn.id]);
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("locked"));
  });

  it("addFolder toasts on a rejected persist", async () => {
    vi.mocked(persistFolder).mockRejectedValueOnce(new Error("disk full"));
    useAppStore.getState().addFolder(makeFolder({ name: "Servers" }));
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Servers"));
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });

  it("deleteFolder toasts on a rejected removal", async () => {
    vi.mocked(removeFolder).mockRejectedValueOnce(new Error("nope"));
    const folder = makeFolder();
    seedConnectionsRegion({ folders: [folder] });
    useAppStore.getState().deleteFolder(folder.id);
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("nope"));
  });

  it("toggleFolder toasts on a rejected persist", async () => {
    vi.mocked(persistFolder).mockRejectedValueOnce(new Error("io"));
    const folder = makeFolder();
    seedConnectionsRegion({ folders: [folder] });
    useAppStore.getState().toggleFolder(folder.id);
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("io"));
  });

  it("duplicateConnection toasts on a rejected persist", async () => {
    vi.mocked(persistConnection).mockRejectedValueOnce(new Error("boom"));
    const conn = makeConnection({ name: "orig" });
    seedConnectionsRegion({ connections: [conn] });
    useAppStore.getState().duplicateConnection(conn.id);
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("orig"));
  });

  it("moveConnectionToFile toasts on a rejected move", async () => {
    vi.mocked(moveConnectionToFile).mockRejectedValueOnce(new Error("perm"));
    const conn = makeConnection({ name: "mover", sourceFile: null });
    seedConnectionsRegion({ connections: [conn] });
    await useAppStore.getState().moveConnectionToFile(conn.id, "other.json");
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("perm"));
  });

  it("moveConnectionToFolder toasts on a rejected persist", async () => {
    vi.mocked(persistConnection).mockRejectedValueOnce(new Error("bad"));
    const conn = makeConnection({ name: "movee" });
    seedConnectionsRegion({ connections: [conn] });
    useAppStore.getState().moveConnectionToFolder(conn.id, "folder-1");
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("bad"));
  });

  it("bulkMoveConnectionsToFolder toasts on a rejected persist", async () => {
    vi.mocked(persistConnection).mockRejectedValueOnce(new Error("nope"));
    const conn = makeConnection();
    seedConnectionsRegion({ connections: [conn] });
    useAppStore.getState().bulkMoveConnectionsToFolder([conn.id], "folder-1");
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("nope"));
  });
});

describe("#1472 — agent mutating actions surface errors", () => {
  it("addRemoteAgent toasts on a rejected persist", async () => {
    vi.mocked(persistAgent).mockRejectedValueOnce(new Error("disk"));
    useAppStore.getState().addRemoteAgent(makeAgent({ name: "edge" }));
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("edge"));
  });

  it("updateRemoteAgent toasts on a rejected persist", async () => {
    vi.mocked(persistAgent).mockRejectedValueOnce(new Error("disk"));
    const agent = makeAgent({ name: "edge" });
    seedAgentsRegion({ remoteAgents: [agent] });
    useAppStore.getState().updateRemoteAgent({ ...agent, name: "edge2" });
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("edge2"));
  });

  it("reorderRemoteAgents toasts on a rejected persist", async () => {
    vi.mocked(reorderAgents).mockRejectedValueOnce(new Error("order fail"));
    seedAgentsRegion({ remoteAgents: [makeAgent(), makeAgent()] });
    useAppStore.getState().reorderRemoteAgents(0, 1);
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("order fail"));
  });

  it("deleteRemoteAgent toasts on a rejected removal", async () => {
    vi.mocked(removeAgent).mockRejectedValueOnce(new Error("busy"));
    const agent = makeAgent({ name: "gone" });
    seedAgentsRegion({ remoteAgents: [agent] });
    useAppStore.getState().deleteRemoteAgent(agent.id);
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("busy"));
  });

  it("disconnectRemoteAgent toasts on a rejected disconnect", async () => {
    vi.mocked(disconnectAgent).mockRejectedValueOnce(new Error("hung"));
    await useAppStore.getState().disconnectRemoteAgent(AGENT_ID);
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("hung"));
  });

  it("refreshAgentSessions toasts on a rejected list", async () => {
    vi.mocked(listAgentSessions).mockRejectedValueOnce(new Error("no route"));
    await useAppStore.getState().refreshAgentSessions(AGENT_ID);
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("no route"));
  });

  it("saveAgentDef toasts on a rejected save", async () => {
    vi.mocked(saveAgentDefinition).mockRejectedValueOnce(new Error("denied"));
    await useAppStore.getState().saveAgentDef(AGENT_ID, {
      name: "x",
      type: "shell",
      config: {},
      persistent: false,
      folder_id: null,
      terminal_options: null,
      icon: null,
    });
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("denied"));
  });

  it("deleteAgentDef toasts on a rejected delete", async () => {
    vi.mocked(deleteAgentDefinition).mockRejectedValueOnce(new Error("missing"));
    await useAppStore.getState().deleteAgentDef(AGENT_ID, "def-1");
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("missing"));
  });

  it("updateAgentDef toasts on a rejected update", async () => {
    vi.mocked(updateAgentDefinition).mockRejectedValueOnce(new Error("stale"));
    await useAppStore.getState().updateAgentDef(AGENT_ID, { id: "def-1", name: "y" });
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("stale"));
  });

  it("deleteAgentFolder toasts on a rejected delete", async () => {
    vi.mocked(deleteAgentFolder).mockRejectedValueOnce(new Error("locked"));
    await useAppStore.getState().deleteAgentFolder(AGENT_ID, "folder-1");
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("locked"));
  });
});

describe("#1472 — workspace and session mutating actions surface errors", () => {
  it("duplicateWorkspaceInBackend toasts on a rejected duplicate", async () => {
    vi.mocked(duplicateWorkspace).mockRejectedValueOnce(new Error("copy fail"));
    await useAppStore.getState().duplicateWorkspaceInBackend("ws-1");
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("copy fail"));
  });

  it("saveLastSession toasts on a rejected save", async () => {
    vi.mocked(saveLastSession).mockRejectedValueOnce(new Error("write fail"));
    await useAppStore.getState().saveLastSession();
    await flush();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("write fail"),
      expect.objectContaining({ id: "last-session-save-error" })
    );
  });

  it("clearLastSession toasts on a rejected clear", async () => {
    vi.mocked(clearLastSession).mockRejectedValueOnce(new Error("clear fail"));
    await useAppStore.getState().clearLastSession();
    await flush();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("clear fail"));
  });
});
