/**
 * Open tabs follow a saved connection's id change (#3579).
 *
 * A saved connection's id is its tree path, so renaming a folder above it changes
 * the id. The backend re-keys the connection's bookmarks (`file-bookmarks-rekeyed`,
 * #3569) and announces the id change (`connection-ids-changed`); an open tab from
 * that connection must follow, or its Bookmarks menu shows the old, now empty,
 * `connection:<old id>` scope until it is reopened.
 *
 * These tests drive the real wiring: `loadFromBackend` subscribes the store to
 * `connection-ids-changed`, the bookmarks store subscribes to the re-key event,
 * and the backend events are delivered through the mocked Tauri `listen`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      loading: vi.fn(() => "toast-id"),
      info: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
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
  persistConnection: vi.fn(() => Promise.resolve("id")),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/api", () => ({
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  getDefaultShell: vi.fn(() => Promise.resolve(null)),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  startPersistentSession: vi.fn(() => Promise.resolve("sess-1")),
  stopPersistentSession: vi.fn(() => Promise.resolve()),
  attachPersistentTab: vi.fn(() => Promise.resolve(1)),
}));

vi.mock("@/services/workspaceApi", () => ({
  getWorkspaces: vi.fn(() => Promise.resolve([])),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { getActiveTab, useAppStore } from "./appStore";
import { bookmarksForScope, useFileBookmarksStore } from "./fileBookmarksStore";
import { seedLayoutState } from "@/test/layoutState";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";
import { attachPersistentTab, startPersistentSession, stopPersistentSession } from "@/services/api";
import { fileBookmarkScope } from "@/utils/fileBookmarkScope";
import type { ConnectionIdChange, SavedConnection } from "@/types/connection";
import type { FileBookmark, FileBookmarkScopeRekey } from "@/types/fileBookmark";
import type { LeafPanel, TabContent, TerminalTab } from "@/types/terminal";

/** Handlers registered through the mocked Tauri `listen`, by event name. */
const handlers = new Map<string, EventCallback<unknown>[]>();

function emitBackendEvent(event: string, payload: unknown): void {
  for (const handler of handlers.get(event) ?? []) {
    handler({ event, id: 0, payload });
  }
}

function tab(id: string, refs: Partial<TerminalTab>): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "h", port: 22, username: "u" } } as never,
    panelId: "leaf-1",
    isActive: false,
    ...refs,
  };
}

function seedTabs(tabs: TerminalTab[], activeTabId: string): void {
  const leaf: LeafPanel = {
    type: "leaf",
    id: "leaf-1",
    tabs: tabs.map((t) => ({ ...t, isActive: t.id === activeTabId })),
    activeTabId,
  };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

function content(tabId: string): TabContent {
  return useAppStore.getState().tabContent[tabId];
}

function bookmark(id: string, scope: string, path: string): FileBookmark {
  return { id, scope, path, name: path, createdAt: "2026-09-26T00:00:00Z" };
}

setupConnectionsRegion();

beforeEach(async () => {
  handlers.clear();
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    const list = handlers.get(event) ?? [];
    list.push(handler as EventCallback<unknown>);
    handlers.set(event, list);
    return () => {};
  });
  useAppStore.setState(useAppStore.getInitialState());
  await useAppStore.getState().loadFromBackend();
});

describe("open tabs follow a saved connection's id change (#3579)", () => {
  it("after a folder rename, the open tab's bookmark scope still resolves to the connection's bookmarks", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "list_file_browser_bookmarks"
        ? [bookmark("b1", "connection:Work/x", "/srv"), bookmark("b2", "local", "/tmp")]
        : undefined
    );
    await useFileBookmarksStore.getState().load();
    seedTabs([tab("t1", { connectionId: "Work/x" })], "t1");

    const scopeBefore = fileBookmarkScope("session", getActiveTab(useAppStore.getState()));
    expect(scopeBefore).toBe("connection:Work/x");

    // The backend renamed folder "Work" to "Job": it re-keys the bookmarks and
    // announces the id change.
    emitBackendEvent("file-bookmarks-rekeyed", [
      { from: "connection:Work/x", to: "connection:Job/x" },
    ] satisfies FileBookmarkScopeRekey[]);
    emitBackendEvent("connection-ids-changed", [
      { oldId: "Work/x", newId: "Job/x" },
    ] satisfies ConnectionIdChange[]);

    const scope = fileBookmarkScope("session", getActiveTab(useAppStore.getState()));
    expect(scope).toBe("connection:Job/x");
    expect(
      bookmarksForScope(useFileBookmarksStore.getState().bookmarks, scope).map((b) => b.path)
    ).toEqual(["/srv"]);
  });

  it("remaps connectionId and persistentConnectionId and leaves unrelated tabs alone", () => {
    seedTabs(
      [
        tab("from-conn", { connectionId: "Work/x" }),
        tab("persistent", { persistentConnectionId: "Work/x" }),
        tab("other", { connectionId: "Home/y" }),
        tab("adhoc", {}),
      ],
      "from-conn"
    );
    const otherBefore = content("other");
    const adhocBefore = content("adhoc");

    emitBackendEvent("connection-ids-changed", [{ oldId: "Work/x", newId: "Job/x" }]);

    expect(content("from-conn").connectionId).toBe("Job/x");
    expect(content("persistent").persistentConnectionId).toBe("Job/x");
    expect(content("other")).toBe(otherBefore);
    expect(content("adhoc")).toBe(adhocBefore);
  });

  it("applies one batch simultaneously: swaps exchange and chains do not compound", () => {
    seedTabs(
      [
        tab("a", { connectionId: "a" }),
        tab("b", { connectionId: "b" }),
        tab("c", { connectionId: "c", persistentConnectionId: "c" }),
      ],
      "a"
    );

    // A swap of a and b, plus c moving to d, in one persisted operation.
    emitBackendEvent("connection-ids-changed", [
      { oldId: "a", newId: "b" },
      { oldId: "b", newId: "a" },
      { oldId: "c", newId: "d" },
    ]);

    expect(content("a").connectionId).toBe("b");
    expect(content("b").connectionId).toBe("a");
    expect(content("c").connectionId).toBe("d");
    expect(content("c").persistentConnectionId).toBe("d");

    // Successive operations compose: d is renamed again to e.
    emitBackendEvent("connection-ids-changed", [{ oldId: "d", newId: "e" }]);
    expect(content("c").connectionId).toBe("e");
  });

  it("does not touch the store when no tab references a changed id", () => {
    seedTabs([tab("t1", { connectionId: "Home/y" })], "t1");
    const before = useAppStore.getState().tabContent;

    emitBackendEvent("connection-ids-changed", [{ oldId: "Work/x", newId: "Job/x" }]);

    expect(useAppStore.getState().tabContent).toBe(before);
  });
});

describe("saved records follow a connection's id change (#3596)", () => {
  it("re-reads the workflow list, whose on-connect triggers the backend re-pointed", async () => {
    const renamed = [
      {
        id: "wf",
        name: "Deploy",
        tags: [],
        steps: [],
        triggers: [{ kind: "on-connect", connectionIds: ["Job/x"] }],
        parameters: [],
        createdAt: "",
        updatedAt: "",
      },
    ];
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "list_workflows" ? renamed : undefined
    );

    emitBackendEvent("connection-ids-changed", [{ oldId: "Work/x", newId: "Job/x" }]);

    await vi.waitFor(() => expect(useAppStore.getState().workflows).toEqual(renamed));
  });

  it("does not re-read workflows for an empty batch", () => {
    vi.mocked(invoke).mockClear();

    useAppStore.getState().followConnectionIdChanges([]);

    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "list_workflows")).toBe(false);
  });
});

describe("persistent sessions follow a connection's id change (#3595)", () => {
  function savedConnection(id: string): SavedConnection {
    return {
      id,
      name: id.split("/").pop() ?? id,
      config: { type: "ssh", config: { host: "h", port: 22, username: "u" } } as never,
      folderId: null,
    };
  }

  /** What the backend emits for a persistent session's state. */
  function persistentState(connectionId: string, state: string, attachedTabCount = 0): void {
    emitBackendEvent("persistent-session-state-changed", {
      connection_id: connectionId,
      session_id: "sess-1",
      state,
      attached_tab_count: attachedTabCount,
      error_message: null,
    });
  }

  function persistent() {
    return useAppStore.getState().persistentSessions;
  }

  it("a running session shows under the renamed connection, and attach / stop reach it by the new id", async () => {
    seedConnectionsRegion({ connections: [savedConnection("Work/x")] });
    await useAppStore.getState().startPersistentSession("Work/x");
    expect(startPersistentSession).toHaveBeenCalledWith("Work/x", "ssh", expect.anything());
    persistentState("Work/x", "running");
    await useAppStore.getState().attachPersistentSession("Work/x");
    persistentState("Work/x", "attached", 1);
    const [attachedTab] = persistent()["Work/x"].attachedTabIds;
    expect(attachedTab).toBeDefined();

    // Rename "Work" → "Job": the backend re-keys its registry, announces the id
    // change, then reports the moved session under its new id.
    seedConnectionsRegion({ connections: [savedConnection("Job/x")] });
    emitBackendEvent("connection-ids-changed", [
      { oldId: "Work/x", newId: "Job/x" },
    ] satisfies ConnectionIdChange[]);
    persistentState("Job/x", "attached", 1);

    // The sidebar row (keyed by the new id) sees the running session, with its
    // attached tab — so it offers Attach rather than starting a second session.
    expect(persistent()["Work/x"]).toBeUndefined();
    expect(persistent()["Job/x"]).toMatchObject({
      connectionId: "Job/x",
      sessionId: "sess-1",
      state: "attached",
      attachedTabIds: [attachedTab],
    });

    await useAppStore.getState().attachPersistentSession("Job/x");
    expect(attachPersistentTab).toHaveBeenLastCalledWith("Job/x", expect.any(String));
    expect(persistent()["Job/x"].attachedTabIds).toHaveLength(2);

    await useAppStore.getState().stopPersistentSession("Job/x");
    expect(stopPersistentSession).toHaveBeenCalledWith("Job/x");
    persistentState("Job/x", "stopped");
    expect(persistent()).toEqual({});
  });

  it("re-keys the map simultaneously: a swap exchanges the entries", () => {
    useAppStore.setState({
      persistentSessions: {
        a: { connectionId: "a", sessionId: "sa", state: "running", attachedTabIds: [] },
        b: { connectionId: "b", sessionId: "sb", state: "attached", attachedTabIds: ["t"] },
        c: { connectionId: "c", sessionId: "sc", state: "running", attachedTabIds: [] },
      },
    });

    emitBackendEvent("connection-ids-changed", [
      { oldId: "a", newId: "b" },
      { oldId: "b", newId: "a" },
    ]);

    expect(persistent().a).toMatchObject({ connectionId: "a", sessionId: "sb" });
    expect(persistent().b).toMatchObject({ connectionId: "b", sessionId: "sa" });
    expect(persistent().c.sessionId).toBe("sc");
  });

  it("leaves the map untouched when no session's connection changed", () => {
    useAppStore.setState({
      persistentSessions: {
        a: { connectionId: "a", sessionId: "sa", state: "running", attachedTabIds: [] },
      },
    });
    const before = persistent();

    emitBackendEvent("connection-ids-changed", [{ oldId: "x", newId: "y" }]);

    expect(persistent()).toBe(before);
  });
});
