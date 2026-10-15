import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
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

const openWindow = vi.fn();
const sendHandoffToWindow = vi.fn();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  openWindow: (...args: unknown[]) => openWindow(...args),
  sendHandoffToWindow: (...args: unknown[]) => sendHandoffToWindow(...args),
  closeTerminal: vi.fn(() => Promise.resolve()),
  detachPersistentTab: vi.fn(() => Promise.resolve()),
}));

import { extractTabContent, useAppStore } from "./appStore";
import { seedLayoutState } from "@/test/layoutState";
import type { ConnectionConfig, PanelNode, TerminalTab } from "@/types/terminal";
import { collectWindowTabs } from "./layoutHelpers";
import {
  clearEditorBuffers,
  registerEditorBuffer,
  takeCarriedBuffer,
  type EditorBufferSnapshot,
} from "@/utils/editorBufferRegistry";
import type { TabHandoffRecord, WindowInfo } from "@/types/window";

const OTHERS: WindowInfo[] = [{ label: "win-1" }];

function seedSessionTab(sessionId: string): string {
  return useAppStore.getState().addTab("build", "local", undefined, { sessionId });
}

/** Open a file editor tab, register a live buffer for it, and mark it dirty. */
function seedDirtyFileEditor(
  filePath: string,
  content: string,
  overrides: Partial<EditorBufferSnapshot> = {}
): string {
  useAppStore.getState().openEditorTab(filePath, false);
  const tab = collectWindowTabs(useAppStore.getState()).find(
    (t) => t.editorMeta?.filePath === filePath
  );
  if (!tab) throw new Error("editor tab not created");
  registerEditorBuffer(tab.id, () => ({
    content,
    filePath,
    scratch: false,
    dirty: true,
    ...overrides,
  }));
  useAppStore.getState().setEditorDirty(tab.id, true);
  return tab.id;
}

function sentRecords(): TabHandoffRecord[] {
  return sendHandoffToWindow.mock.calls.map((c) => c[1] as TabHandoffRecord);
}

describe("appStore — Move tabs carries unsaved editors (#4412)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    clearEditorBuffers();
    openWindow.mockReset().mockResolvedValue("win-9");
    sendHandoffToWindow.mockReset().mockResolvedValue(undefined);
  });

  describe("prepareWindowClose", () => {
    it("marks a dirty file editor with a live buffer as movable", async () => {
      const tabId = seedDirtyFileEditor("/etc/hosts", "edited");

      await useAppStore.getState().prepareWindowClose(OTHERS);

      expect(useAppStore.getState().pendingWindowClose?.dirtyEditors).toEqual([
        { tabId, title: "hosts", movable: true },
      ]);
    });

    it("marks a dirty connection editor as not movable", async () => {
      const tabId = useAppStore
        .getState()
        .addTab("New Connection", "local", undefined, { contentType: "connection-editor" });
      useAppStore.getState().setEditorDirty(tabId, true);

      await useAppStore.getState().prepareWindowClose(OTHERS);

      expect(useAppStore.getState().pendingWindowClose?.dirtyEditors).toEqual([
        { tabId, title: "New Connection", movable: false },
      ]);
    });
  });

  describe("moveWindowSessionsToWindow", () => {
    it("moves a dirty file editor with its unsaved buffer after the session tabs", async () => {
      seedSessionTab("s1");
      seedDirtyFileEditor("/etc/hosts", "127.0.0.1 edited\n");

      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

      const records = sentRecords();
      expect(records).toHaveLength(2);
      expect(records[0].tab.sessionId).toBe("s1");
      const editor = records[1].tab;
      expect(editor.contentType).toBe("editor");
      expect(editor.editorDirty).toBe(true);
      expect(editor.editorMeta).toMatchObject({ filePath: "/etc/hosts", isRemote: false });
      expect(editor.editorBuffer).toBe("127.0.0.1 edited\n");
    });

    it("moves a window holding only a dirty editor", async () => {
      seedDirtyFileEditor("/etc/hosts", "edited");

      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "new" });

      expect(openWindow).toHaveBeenCalledTimes(1);
      const seeded = openWindow.mock.calls[0][0] as TabHandoffRecord;
      expect(seeded.tab.editorBuffer).toBe("edited");
    });

    it("carries an unsaved scratch buffer as scratch content", async () => {
      useAppStore.getState().openScratchEditorTab("output", "output.txt", "original");
      const tab = collectWindowTabs(useAppStore.getState()).find((t) => t.editorMeta?.scratch);
      registerEditorBuffer(tab!.id, () => ({
        content: "original plus edits",
        filePath: "output.txt",
        scratch: true,
        dirty: true,
      }));
      useAppStore.getState().setEditorDirty(tab!.id, true);

      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

      const meta = sentRecords()[0].tab.editorMeta;
      expect(meta).toMatchObject({ scratch: true, scratchContent: "original plus edits" });
      expect(sentRecords()[0].tab.editorBuffer).toBeUndefined();
      expect(sentRecords()[0].tab.editorDirty).toBe(true);
    });

    it("captures every buffer before handing off, so source teardown cannot drop it", async () => {
      seedSessionTab("s1");
      const tabId = seedDirtyFileEditor("/etc/hosts", "unsaved text");
      // The source window starts tearing down while the first hand-off is in
      // flight: the editor unmounts (unregistering its buffer) and its per-tab
      // state is pruned. The editor record must already hold the text.
      sendHandoffToWindow.mockImplementationOnce(async () => {
        clearEditorBuffers();
        useAppStore.getState().setEditorDirty(tabId, false);
      });

      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

      const editor = sentRecords()[1].tab;
      expect(editor.editorBuffer).toBe("unsaved text");
      expect(editor.editorDirty).toBe(true);
    });

    it("refuses to move while a dirty editor cannot carry its buffer", async () => {
      seedSessionTab("s1");
      const tabId = useAppStore
        .getState()
        .addTab("New Connection", "local", undefined, { contentType: "connection-editor" });
      useAppStore.getState().setEditorDirty(tabId, true);

      await expect(
        useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" })
      ).rejects.toThrow(/New Connection/);

      expect(sendHandoffToWindow).not.toHaveBeenCalled();
      expect(useAppStore.getState().movingSessionIds).toEqual([]);
    });

    it("still moves session tabs as before when no editor is dirty", async () => {
      seedSessionTab("s1");
      seedSessionTab("s2");

      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

      expect(sentRecords().map((r) => r.tab.sessionId)).toEqual(["s1", "s2"]);
      expect(useAppStore.getState().movingSessionIds).toEqual(["s1", "s2"]);
    });
  });

  describe("hydrateHandoffTab (destination window)", () => {
    it("restores the moved editor with its unsaved buffer and dirty state", async () => {
      seedDirtyFileEditor("/etc/hosts", "unsaved text");
      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });
      const [record] = sentRecords();

      // The destination is a different window: a fresh store.
      useAppStore.setState(useAppStore.getInitialState());
      clearEditorBuffers();
      useAppStore.getState().hydrateHandoffTab(record);

      const tab = collectWindowTabs(useAppStore.getState()).find((t) => t.contentType === "editor");
      expect(tab?.editorMeta).toMatchObject({ filePath: "/etc/hosts", isRemote: false });
      expect(useAppStore.getState().editorDirtyTabs[tab!.id]).toBe(true);
      // The text waits, once, for the editor that mounts for the new tab.
      expect(takeCarriedBuffer(tab!.id)).toBe("unsaved text");
      expect(takeCarriedBuffer(tab!.id)).toBeNull();
    });
  });
});

/** A session-less tab of `contentType` with the given metadata, for seeding. */
function staticTab(id: string, title: string, fields: Partial<TerminalTab>): TerminalTab {
  return {
    id,
    sessionId: null,
    title,
    connectionType: "local",
    contentType: "settings",
    config: { type: "local", config: {} } as ConnectionConfig,
    panelId: "a",
    isActive: false,
    ...fields,
  };
}

/** One tab of every session-less kind "Move tabs" reopens elsewhere (#4501). */
const MOVABLE_TABS: TerminalTab[] = [
  staticTab("st", "Settings", { contentType: "settings" }),
  staticTab("lv", "Logs", { contentType: "log-viewer" }),
  staticTab("nd", "Ping: host-a", {
    contentType: "network-diagnostic",
    networkDiagnosticMeta: { tool: "ping", prefillHost: "host-a" },
  }),
  staticTab("pd", "Demo plugin", {
    contentType: "plugin-detail",
    pluginDetailMeta: { pluginId: "demo.plugin" },
  }),
  staticTab("ce", "Edit server-1", {
    contentType: "connection-editor",
    connectionEditorMeta: { connectionId: "conn-1", folderId: null },
  }),
  staticTab("te", "Edit tunnel", {
    contentType: "tunnel-editor",
    tunnelEditorMeta: { tunnelId: "tun-1" },
  }),
  staticTab("we", "Edit workspace", {
    contentType: "workspace-editor",
    workspaceEditorMeta: { workspaceId: "ws-1" },
  }),
  staticTab("ae", "Def (error)", {
    connectionType: "remote-session",
    contentType: "agent-error",
    agentErrorMeta: {
      agentId: "ag1",
      agentName: "Agent 1",
      definitionId: "def1",
      definitionName: "Def",
      error: "agent offline",
    },
    workspaceAgentRef: { agentId: "ag1", definitionId: "def1" },
  }),
];

const TRANSFER_VIEW = staticTab("tv", "Transfers", {
  contentType: "transfer-view",
  transferViewMeta: { remoteTabId: "t-term" },
});

/** Install a one-panel layout holding `tabs`. */
function seedTabs(tabs: TerminalTab[]): void {
  const root: PanelNode = {
    type: "leaf",
    id: "a",
    tabs: tabs.map((tab, i) => ({ ...tab, isActive: i === tabs.length - 1 })),
    activeTabId: tabs[tabs.length - 1]?.id ?? null,
  };
  seedLayoutState({
    rootPanel: root,
    activePanelId: "a",
    tabGroups: [{ id: "g1", name: "Main", rootPanel: root, activePanelId: "a" }],
    activeTabGroupId: "g1",
    tabContent: Object.fromEntries(tabs.map((tab) => [tab.id, extractTabContent(tab)])),
  });
}

/** Hydrate `records` into a fresh store, as the destination window does. */
function hydrateInFreshWindow(records: TabHandoffRecord[]): TerminalTab[] {
  useAppStore.setState(useAppStore.getInitialState());
  clearEditorBuffers();
  for (const record of records) useAppStore.getState().hydrateHandoffTab(record);
  return collectWindowTabs(useAppStore.getState());
}

describe("appStore — Move tabs carries clean non-session tabs (#4501)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    clearEditorBuffers();
    openWindow.mockReset().mockResolvedValue("win-9");
    sendHandoffToWindow.mockReset().mockResolvedValue(undefined);
  });

  it("a clean file editor tab appears in the target window after Move", async () => {
    seedSessionTab("s1");
    useAppStore.getState().openEditorTab("/etc/hosts", false);

    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

    const records = sentRecords();
    expect(records.map((r) => r.tab.contentType)).toEqual(["terminal", "editor"]);
    expect(records[1].tab.editorDirty).toBeUndefined();
    expect(records[1].tab.editorBuffer).toBeUndefined();

    const tabs = hydrateInFreshWindow(records);
    const editor = tabs.find((t) => t.contentType === "editor");
    expect(editor?.editorMeta).toMatchObject({ filePath: "/etc/hosts", isRemote: false });
    expect(editor?.title).toBe("hosts");
    expect(useAppStore.getState().editorDirtyTabs[editor!.id]).toBeUndefined();
  });

  it("moves a window that holds only clean file editors", async () => {
    useAppStore.getState().openEditorTab("/etc/hosts", false);

    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "new" });

    expect(openWindow).toHaveBeenCalledTimes(1);
    const seeded = openWindow.mock.calls[0][0] as TabHandoffRecord;
    expect(seeded.tab.editorMeta).toMatchObject({ filePath: "/etc/hosts" });
  });

  it.each(MOVABLE_TABS.map((tab) => [tab.contentType, tab] as const))(
    "reopens a %s tab in the target window with its metadata",
    async (_kind, tab) => {
      seedTabs([tab]);

      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

      const records = sentRecords();
      expect(records).toHaveLength(1);
      const [moved] = hydrateInFreshWindow(records).filter(
        (t) => t.contentType === tab.contentType
      );
      expect(moved).toBeDefined();
      expect(moved.title).toBe(tab.title);
      expect(moved.sessionId).toBeNull();
      for (const key of [
        "networkDiagnosticMeta",
        "pluginDetailMeta",
        "connectionEditorMeta",
        "tunnelEditorMeta",
        "workspaceEditorMeta",
        "agentErrorMeta",
        "workspaceAgentRef",
      ] as const) {
        expect(moved[key]).toEqual(tab[key]);
      }
    }
  );

  it("moves every movable kind in one go, after the session tabs", async () => {
    seedTabs([...MOVABLE_TABS, TRANSFER_VIEW]);
    seedSessionTab("s1");

    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

    const kinds = sentRecords().map((r) => r.tab.contentType);
    expect(kinds).toEqual(["terminal", ...MOVABLE_TABS.map((tab) => tab.contentType)]);
  });

  it("leaves a transfer view behind, since its remote pane is bound to a source tab", async () => {
    seedTabs([TRANSFER_VIEW]);

    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

    expect(sendHandoffToWindow).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("still refuses the move while a dirty form editor cannot carry its state", async () => {
    const formEditor = MOVABLE_TABS.find((t) => t.contentType === "connection-editor")!;
    seedTabs([formEditor]);
    useAppStore.getState().setEditorDirty(formEditor.id, true);

    await expect(
      useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" })
    ).rejects.toThrow(/Edit server-1/);
    expect(sendHandoffToWindow).not.toHaveBeenCalled();
  });

  it("lists the other tabs with whether each moves in the close request", async () => {
    const settings = MOVABLE_TABS[0];
    seedTabs([settings, TRANSFER_VIEW]);
    seedSessionTab("s1");

    await useAppStore.getState().prepareWindowClose(OTHERS);

    expect(useAppStore.getState().pendingWindowClose?.otherTabs).toEqual([
      { tabId: "st", title: "Settings", contentType: "settings", movable: true },
      { tabId: "tv", title: "Transfers", contentType: "transfer-view", movable: false },
    ]);
  });

  it("keeps an unsaved editor out of the other tabs, since it has its own row", async () => {
    seedSessionTab("s1");
    const tabId = seedDirtyFileEditor("/etc/hosts", "edited");

    await useAppStore.getState().prepareWindowClose(OTHERS);

    const request = useAppStore.getState().pendingWindowClose;
    expect(request?.dirtyEditors?.map((e) => e.tabId)).toEqual([tabId]);
    expect(request?.otherTabs).toBeUndefined();
  });

  describe("hydrateHandoffTab de-duplication", () => {
    it("activates the target's own Settings tab instead of opening a second", async () => {
      seedTabs([MOVABLE_TABS[0]]);
      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });
      const [record] = sentRecords();

      useAppStore.setState(useAppStore.getInitialState());
      useAppStore.getState().openSettingsTab();
      useAppStore.getState().hydrateHandoffTab(record);

      const settings = collectWindowTabs(useAppStore.getState()).filter(
        (t) => t.contentType === "settings"
      );
      expect(settings).toHaveLength(1);
      expect(settings[0].isActive).toBe(true);
    });

    it("activates an already open copy of the same saved local file", async () => {
      useAppStore.getState().openEditorTab("/etc/hosts", false);
      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });
      const [record] = sentRecords();

      useAppStore.setState(useAppStore.getInitialState());
      useAppStore.getState().openEditorTab("/etc/hosts", false);
      useAppStore.getState().hydrateHandoffTab(record);

      const editors = collectWindowTabs(useAppStore.getState()).filter(
        (t) => t.contentType === "editor"
      );
      expect(editors).toHaveLength(1);
    });

    it("never merges an editor that carries unsaved changes", async () => {
      seedDirtyFileEditor("/etc/hosts", "edited");
      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });
      const [record] = sentRecords();

      useAppStore.setState(useAppStore.getInitialState());
      useAppStore.getState().openEditorTab("/etc/hosts", false);
      useAppStore.getState().hydrateHandoffTab(record);

      const editors = collectWindowTabs(useAppStore.getState()).filter(
        (t) => t.contentType === "editor"
      );
      expect(editors).toHaveLength(2);
    });
  });
});
