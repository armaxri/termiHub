import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockStartPersistentSession,
  mockStopPersistentSession,
  mockAttachPersistentTab,
  mockConnectAgent,
} = vi.hoisted(() => ({
  mockStartPersistentSession: vi.fn().mockResolvedValue("new-session-id"),
  mockStopPersistentSession: vi.fn().mockResolvedValue(undefined),
  mockAttachPersistentTab: vi.fn().mockResolvedValue(1),
  mockConnectAgent: vi.fn().mockResolvedValue({ capabilities: {} }),
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
  startPersistentSession: mockStartPersistentSession,
  stopPersistentSession: mockStopPersistentSession,
  attachPersistentTab: mockAttachPersistentTab,
  connectAgent: mockConnectAgent,
  disconnectAgent: vi.fn(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(() => Promise.resolve({})),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  removeCredential: vi.fn(() => Promise.resolve()),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
  sessionGetCapabilities: vi.fn(() => Promise.resolve({})),
}));

import { useAppStore } from "./appStore";
import { layoutState } from "@/test/layoutState";
import { getAllLeaves } from "@/utils/panelTree";
import type { PersistentSessionEntry } from "@/types/connection";

const AGENT_ID = "agent-1";
const DEF_ID = "def-1";
const CONNECTION_ID = `${AGENT_ID}:${DEF_ID}`;

function findTab(tabId: string) {
  const state = layoutState();
  return [
    ...getAllLeaves(state.rootPanel).flatMap((l) => l.tabs),
    ...state.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)),
  ].find((t) => t.id === tabId);
}

/** Create a terminal tab attached to the agent-hosted persistent session. */
function makePersistentTab(oldSessionId: string | null): string {
  return layoutState().addTab(
    "Persistent Shell",
    "remote-session",
    {
      type: "remote-session",
      config: {
        agentId: AGENT_ID,
        sessionType: "shell",
        shell: "/bin/bash",
        persistent: true,
        title: "Persistent Shell",
      },
    },
    {
      contentType: "terminal",
      sessionId: oldSessionId,
      persistentConnectionId: CONNECTION_ID,
    }
  );
}

describe("appStore — restartPersistentSessionForTab", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    mockStartPersistentSession.mockResolvedValue("new-session-id");
    mockAttachPersistentTab.mockResolvedValue(1);
  });

  it("starts a fresh persistent session and writes the new session id onto the tab", async () => {
    const tabId = makePersistentTab("dead-session-id");

    const result = await useAppStore.getState().restartPersistentSessionForTab(tabId);

    expect(mockStartPersistentSession).toHaveBeenCalledWith(
      CONNECTION_ID,
      "shell",
      expect.objectContaining({ shell: "/bin/bash", title: "Persistent Shell" }),
      AGENT_ID
    );
    expect(result).toBe("new-session-id");
    // The tab must point at the NEW live session, not the dead one — otherwise
    // the terminal reattaches to a corpse and the reconnect loops forever.
    expect(findTab(tabId)?.sessionId).toBe("new-session-id");
  });

  it("registers the tab as attached to the restarted persistent session", async () => {
    const tabId = makePersistentTab("dead-session-id");

    await useAppStore.getState().restartPersistentSessionForTab(tabId);

    expect(mockAttachPersistentTab).toHaveBeenCalledWith(CONNECTION_ID, tabId);
  });

  it("reuses an already-running persistent session instead of starting a new one", async () => {
    const tabId = makePersistentTab("live-session-id");
    useAppStore.setState({
      persistentSessions: {
        [CONNECTION_ID]: {
          connectionId: CONNECTION_ID,
          sessionId: "live-session-id",
          state: "running",
          attachedTabIds: [],
        } satisfies PersistentSessionEntry,
      },
    });

    const result = await useAppStore.getState().restartPersistentSessionForTab(tabId);

    expect(mockStartPersistentSession).not.toHaveBeenCalled();
    expect(result).toBe("live-session-id");
  });

  it("returns null for a tab without a persistent connection id", async () => {
    const tabId = layoutState().addTab("Local", "local", {
      type: "local",
      config: {},
    });

    const result = await useAppStore.getState().restartPersistentSessionForTab(tabId);

    expect(result).toBeNull();
    expect(mockStartPersistentSession).not.toHaveBeenCalled();
  });

  it("returns null (does not throw) when the restart API fails", async () => {
    mockStartPersistentSession.mockRejectedValueOnce(new Error("agent offline"));
    const tabId = makePersistentTab("dead-session-id");

    const result = await useAppStore.getState().restartPersistentSessionForTab(tabId);

    expect(result).toBeNull();
    // The tab session id must not be set to a bogus value on failure.
    expect(findTab(tabId)?.sessionId).toBeNull();
  });
});
