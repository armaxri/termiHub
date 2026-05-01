import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockStartPersistentSession, mockStopPersistentSession, mockAttachPersistentTab } =
  vi.hoisted(() => ({
    mockStartPersistentSession: vi.fn().mockResolvedValue("mock-session-id"),
    mockStopPersistentSession: vi.fn().mockResolvedValue(undefined),
    mockAttachPersistentTab: vi.fn().mockResolvedValue(1),
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
  connectAgent: vi.fn(),
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
}));

import { useAppStore } from "./appStore";
import type { AgentDefinitionInfo } from "@/services/api";
import type { PersistentSessionEntry } from "@/types/connection";

const AGENT_ID = "agent-test-1";

function makeDef(overrides: Partial<AgentDefinitionInfo> = {}): AgentDefinitionInfo {
  return {
    id: "def-1",
    name: "Persistent Shell",
    sessionType: "shell",
    config: { shell: "/bin/bash" },
    persistent: true,
    folderId: null,
    ...overrides,
  };
}

const CONNECTION_ID = `${AGENT_ID}:def-1`;

function seedRunningEntry(sessionId = "mock-session-id") {
  useAppStore.setState({
    persistentSessions: {
      [CONNECTION_ID]: {
        connectionId: CONNECTION_ID,
        sessionId,
        state: "running",
        attachedTabIds: [],
      } satisfies PersistentSessionEntry,
    },
  });
}

describe("appStore — persistent sessions", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  // ── startAgentPersistentSession ────────────────────────────────────

  describe("startAgentPersistentSession", () => {
    it("initializes entry with 'starting' state synchronously before API resolves", async () => {
      let capturedState: PersistentSessionEntry | undefined;
      mockStartPersistentSession.mockImplementation(async () => {
        capturedState = useAppStore.getState().persistentSessions[CONNECTION_ID];
        return "mock-session-id";
      });

      await useAppStore.getState().startAgentPersistentSession(AGENT_ID, makeDef());

      expect(capturedState?.state).toBe("starting");
      expect(capturedState?.sessionId).toBeNull();
      expect(capturedState?.attachedTabIds).toEqual([]);
    });

    it("calls API with correct connectionId, typeId, settings, and agentId", async () => {
      await useAppStore.getState().startAgentPersistentSession(AGENT_ID, makeDef());

      expect(mockStartPersistentSession).toHaveBeenCalledWith(
        CONNECTION_ID,
        "shell",
        { shell: "/bin/bash", title: "Persistent Shell" },
        AGENT_ID
      );
    });

    it("passes agentId as the fourth argument to the API", async () => {
      await useAppStore.getState().startAgentPersistentSession(AGENT_ID, makeDef());

      const [, , , agentId] = mockStartPersistentSession.mock.calls[0];
      expect(agentId).toBe(AGENT_ID);
    });

    it("transitions entry to 'error' state on API failure", async () => {
      mockStartPersistentSession.mockRejectedValueOnce(new Error("connection refused"));

      await useAppStore.getState().startAgentPersistentSession(AGENT_ID, makeDef());

      const entry = useAppStore.getState().persistentSessions[CONNECTION_ID];
      expect(entry?.state).toBe("error");
      expect(entry?.errorMessage).toContain("connection refused");
    });

    it("preserves 'starting' state after API success (backend event drives transition)", async () => {
      await useAppStore.getState().startAgentPersistentSession(AGENT_ID, makeDef());

      const entry = useAppStore.getState().persistentSessions[CONNECTION_ID];
      // The event handler (onPersistentSessionStateChanged) drives the "running" transition;
      // the store action itself does not update state on success.
      expect(entry?.state).toBe("starting");
    });
  });

  // ── attachAgentPersistentSession ───────────────────────────────────

  describe("attachAgentPersistentSession", () => {
    it("returns early without opening a tab when entry has no sessionId", async () => {
      useAppStore.setState({
        persistentSessions: {
          [CONNECTION_ID]: {
            connectionId: CONNECTION_ID,
            sessionId: null,
            state: "starting",
            attachedTabIds: [],
          },
        },
      });

      await useAppStore.getState().attachAgentPersistentSession(AGENT_ID, makeDef());

      expect(mockAttachPersistentTab).not.toHaveBeenCalled();
      const entry = useAppStore.getState().persistentSessions[CONNECTION_ID];
      expect(entry.attachedTabIds).toEqual([]);
    });

    it("returns early when no persistent entry exists for the connection", async () => {
      await useAppStore.getState().attachAgentPersistentSession(AGENT_ID, makeDef());
      expect(mockAttachPersistentTab).not.toHaveBeenCalled();
    });

    it("calls attachPersistentTab with correct connectionId and a tab ID", async () => {
      seedRunningEntry();

      await useAppStore.getState().attachAgentPersistentSession(AGENT_ID, makeDef());

      expect(mockAttachPersistentTab).toHaveBeenCalledWith(CONNECTION_ID, expect.any(String));
    });

    it("adds the new tab ID to attachedTabIds on success", async () => {
      seedRunningEntry();

      await useAppStore.getState().attachAgentPersistentSession(AGENT_ID, makeDef());

      const entry = useAppStore.getState().persistentSessions[CONNECTION_ID];
      expect(entry.attachedTabIds).toHaveLength(1);
    });

    it("accumulates multiple attached tab IDs on repeated calls", async () => {
      seedRunningEntry();

      await useAppStore.getState().attachAgentPersistentSession(AGENT_ID, makeDef());
      await useAppStore.getState().attachAgentPersistentSession(AGENT_ID, makeDef());

      const entry = useAppStore.getState().persistentSessions[CONNECTION_ID];
      expect(entry.attachedTabIds).toHaveLength(2);
      // All IDs must be unique
      expect(new Set(entry.attachedTabIds).size).toBe(2);
    });
  });

  // ── stopPersistentSession ──────────────────────────────────────────

  describe("stopPersistentSession", () => {
    it("sets 'stopping' state immediately before the API resolves", async () => {
      seedRunningEntry();

      let capturedState: PersistentSessionEntry | undefined;
      mockStopPersistentSession.mockImplementation(async () => {
        capturedState = useAppStore.getState().persistentSessions[CONNECTION_ID];
      });

      await useAppStore.getState().stopPersistentSession(CONNECTION_ID);

      expect(capturedState?.state).toBe("stopping");
    });

    it("calls stopPersistentSession API with the correct connectionId", async () => {
      seedRunningEntry();

      await useAppStore.getState().stopPersistentSession(CONNECTION_ID);

      expect(mockStopPersistentSession).toHaveBeenCalledWith(CONNECTION_ID);
    });
  });

  // ── setPersistentSessionEntry ──────────────────────────────────────

  describe("setPersistentSessionEntry", () => {
    it("patches an existing entry without losing other fields", () => {
      seedRunningEntry("sess-abc");

      useAppStore.getState().setPersistentSessionEntry(CONNECTION_ID, { state: "attached" });

      const entry = useAppStore.getState().persistentSessions[CONNECTION_ID];
      expect(entry.state).toBe("attached");
      expect(entry.sessionId).toBe("sess-abc");
      expect(entry.connectionId).toBe(CONNECTION_ID);
    });

    it("is a no-op when the entry does not exist", () => {
      useAppStore.getState().setPersistentSessionEntry("nonexistent:x", { state: "attached" });
      expect(useAppStore.getState().persistentSessions["nonexistent:x"]).toBeUndefined();
    });

    it("can update sessionId", () => {
      seedRunningEntry("old-id");

      useAppStore.getState().setPersistentSessionEntry(CONNECTION_ID, { sessionId: "new-id" });

      expect(useAppStore.getState().persistentSessions[CONNECTION_ID].sessionId).toBe("new-id");
    });
  });

  // ── setPersistentSessionError ──────────────────────────────────────

  describe("setPersistentSessionError", () => {
    it("transitions existing entry to 'error' state with message", () => {
      seedRunningEntry();

      useAppStore.getState().setPersistentSessionError(CONNECTION_ID, "timeout after 30s");

      const entry = useAppStore.getState().persistentSessions[CONNECTION_ID];
      expect(entry.state).toBe("error");
      expect(entry.errorMessage).toBe("timeout after 30s");
    });

    it("is a no-op when the entry does not exist", () => {
      useAppStore.getState().setPersistentSessionError("nonexistent:x", "boom");
      expect(useAppStore.getState().persistentSessions["nonexistent:x"]).toBeUndefined();
    });
  });
});
