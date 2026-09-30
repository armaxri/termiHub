/**
 * Branch coverage for the persistent-sessions slice (#2979): an entry dropped
 * (session stopped) while a start/attach is in flight is never resurrected, the
 * spawn picker toggles, `attached` counts as live for start-and-attach and
 * restart, a restart never double-registers a tab, and a restart reconstructs a
 * definition from a sparse tab config.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const m = vi.hoisted(() => ({
  startPersistentSession: vi.fn(),
  attachPersistentTab: vi.fn(),
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() => Promise.resolve({ version: "1", externalConnectionFiles: [] })),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  startPersistentSession: (...a: unknown[]) => m.startPersistentSession(...a),
  attachPersistentTab: (...a: unknown[]) => m.attachPersistentTab(...a),
  stopPersistentSession: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "./appStore";
import type { AgentDefinitionInfo } from "@/services/api";
import type { PersistentSessionEntry } from "@/types/connection";
import type { ConnectionConfig } from "@/types/terminal";
import type { SpawnRequestPayload } from "@/services/events";
import { collectLiveTabs } from "./layoutHelpers";
import { setConnectionsViewForTest } from "./connectionsBridge";
import type { SavedConnection } from "@/types/connection";

const AGENT = "agent-1";
const CONN = `${AGENT}:def-1`;

const def: AgentDefinitionInfo = {
  id: "def-1",
  name: "Shell",
  sessionType: "shell",
  config: {},
  persistent: true,
  folderId: null,
};

function seed(entry: Partial<PersistentSessionEntry> = {}): void {
  useAppStore.setState({
    persistentSessions: {
      [CONN]: {
        connectionId: CONN,
        sessionId: "s-live",
        state: "running",
        attachedTabIds: [],
        ...entry,
      },
    },
  });
}

/** Drop the entry the way a `stopped` state event does. */
function dropEntry(): void {
  useAppStore.setState({ persistentSessions: {} });
}

/** A promise the test resolves by hand, to interleave events with an await. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function addPersistentTab(config: ConnectionConfig, sessionId: string | null = "s-old"): string {
  return useAppStore.getState().addTab("agent tab", "remote-session", config, {
    contentType: "terminal",
    sessionId: sessionId ?? undefined,
    persistentConnectionId: CONN,
  });
}

function tab(tabId: string) {
  return collectLiveTabs(useAppStore.getState()).find((t) => t.id === tabId)!;
}

describe("persistentSessionsSlice — branch coverage (#2979)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    setConnectionsViewForTest({ folders: [], connections: [] });
    m.startPersistentSession.mockReset().mockResolvedValue("s-new");
    m.attachPersistentTab.mockReset().mockResolvedValue(1);
  });

  it("shows and hides the spawn picker", () => {
    const request = { agentId: AGENT } as unknown as SpawnRequestPayload;
    useAppStore.getState().showSpawnPicker(request);
    expect(useAppStore.getState()).toMatchObject({
      spawnPickerVisible: true,
      spawnPickerRequest: request,
    });
    useAppStore.getState().hideSpawnPicker();
    expect(useAppStore.getState().spawnPickerVisible).toBe(false);
    expect(useAppStore.getState().spawnPickerRequest).toBeUndefined();
  });

  describe("an entry dropped mid-flight is not resurrected", () => {
    it("startAgentPersistentSession", async () => {
      const start = deferred<string>();
      m.startPersistentSession.mockReturnValue(start.promise);

      const pending = useAppStore.getState().startAgentPersistentSession(AGENT, def);
      dropEntry();
      start.resolve("s-new");

      await expect(pending).resolves.toBe("s-new");
      expect(useAppStore.getState().persistentSessions).toEqual({});
    });

    it("a failed start records a well-formed error entry even after a drop", async () => {
      const start = deferred<string>();
      m.startPersistentSession.mockReturnValue(start.promise);

      const pending = useAppStore.getState().startAgentPersistentSession(AGENT, def);
      dropEntry();
      start.reject(new Error("agent gone"));

      await expect(pending).resolves.toBeNull();
      // The error must surface on a complete entry — a partial one (no
      // connectionId / attachedTabIds) crashes every reader that walks it.
      expect(useAppStore.getState().persistentSessions[CONN]).toEqual({
        connectionId: CONN,
        sessionId: null,
        state: "error",
        errorMessage: "agent gone",
        attachedTabIds: [],
      });
    });

    it("a failed saved-connection start records a well-formed error entry after a drop", async () => {
      setConnectionsViewForTest({
        folders: [],
        connections: [
          {
            id: "saved-1",
            name: "Saved",
            config: { type: "local", config: {} },
            folderId: null,
          } as unknown as SavedConnection,
        ],
      });
      const start = deferred<string>();
      m.startPersistentSession.mockReturnValue(start.promise);

      const pending = useAppStore.getState().startPersistentSession("saved-1");
      dropEntry();
      start.reject(new Error("spawn failed"));
      await pending;

      expect(useAppStore.getState().persistentSessions["saved-1"]).toEqual({
        connectionId: "saved-1",
        sessionId: null,
        state: "error",
        errorMessage: "spawn failed",
        attachedTabIds: [],
      });
    });

    it("attachAgentPersistentSession", async () => {
      seed();
      const attach = deferred<number>();
      m.attachPersistentTab.mockReturnValue(attach.promise);

      const pending = useAppStore.getState().attachAgentPersistentSession(AGENT, def);
      dropEntry();
      attach.resolve(1);
      await pending;

      expect(useAppStore.getState().persistentSessions).toEqual({});
    });

    it("restartPersistentSessionForTab's tab registration", async () => {
      seed({ state: "attached" });
      const tabId = addPersistentTab({ type: "remote-session", config: { agentId: AGENT } });
      const attach = deferred<number>();
      m.attachPersistentTab.mockReturnValue(attach.promise);

      const pending = useAppStore.getState().restartPersistentSessionForTab(tabId);
      dropEntry();
      attach.resolve(1);

      await expect(pending).resolves.toBe("s-live");
      expect(useAppStore.getState().persistentSessions).toEqual({});
    });
  });

  it("startAndAttach reuses an 'attached' session instead of starting another", async () => {
    seed({ state: "attached" });

    await useAppStore.getState().startAndAttachAgentPersistentSession(AGENT, def);

    expect(m.startPersistentSession).not.toHaveBeenCalled();
    expect(m.attachPersistentTab).toHaveBeenCalledTimes(1);
  });

  it("restart re-points the tab at a live session without double-registering it", async () => {
    const tabId = addPersistentTab({ type: "remote-session", config: { agentId: AGENT } });
    seed({ state: "running", attachedTabIds: [tabId] });

    const sessionId = await useAppStore.getState().restartPersistentSessionForTab(tabId);

    expect(sessionId).toBe("s-live");
    expect(tab(tabId).sessionId).toBe("s-live");
    expect(useAppStore.getState().persistentSessions[CONN].attachedTabIds).toEqual([tabId]);
  });

  it("restart rebuilds a definition from a sparse tab config", async () => {
    // No live entry, and a config with neither a title nor a session type: the
    // definition falls back to the tab title and a plain shell.
    const tabId = addPersistentTab({
      type: "remote-session",
      config: { agentId: AGENT, persistent: true, shell: "/bin/zsh" },
    });

    const sessionId = await useAppStore.getState().restartPersistentSessionForTab(tabId);

    expect(sessionId).toBe("s-new");
    expect(m.startPersistentSession).toHaveBeenCalledWith(
      CONN,
      "shell",
      { shell: "/bin/zsh", title: "agent tab", definitionId: "def-1" },
      AGENT
    );
    expect(tab(tabId).sessionId).toBe("s-new");
  });

  it("restart refuses a tab whose connection id does not belong to its agent", async () => {
    const tabId = addPersistentTab({ type: "remote-session", config: { agentId: "other" } });
    await expect(useAppStore.getState().restartPersistentSessionForTab(tabId)).resolves.toBeNull();
    expect(m.startPersistentSession).not.toHaveBeenCalled();
  });
});
