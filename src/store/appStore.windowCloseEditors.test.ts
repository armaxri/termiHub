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
  peekCarriedFormDraft,
  readFormDraft,
  registerEditorBuffer,
  registerFormDraft,
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

    it("marks a dirty connection editor without a readable draft as not movable", async () => {
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
    expect(kinds).toEqual([
      "terminal",
      ...MOVABLE_TABS.map((tab) => tab.contentType),
      "transfer-view",
    ]);
  });

  it("still refuses the move while a dirty form editor has no readable draft", async () => {
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
      {
        tabId: "tv",
        title: "Transfers",
        contentType: "transfer-view",
        movable: true,
        unpaired: true,
      },
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

describe("appStore — Move tabs carries the transfer view (#4751)", () => {
  const TERMINAL = staticTab("t-term", "build", { contentType: "terminal", sessionId: "s1" });
  const PAIRED_VIEW = staticTab("tv", "Transfer: build", {
    contentType: "transfer-view",
    transferViewMeta: { remoteTabId: "t-term", localPath: "/home/me", remotePath: "/srv/app" },
  });

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    clearEditorBuffers();
    openWindow.mockReset().mockResolvedValue("win-9");
    sendHandoffToWindow.mockReset().mockResolvedValue(undefined);
  });

  it("keeps a transfer view paired with its moved terminal in the target window", async () => {
    // The view sits before its terminal in the window; the move still hands the
    // terminal over first.
    seedTabs([PAIRED_VIEW, TERMINAL]);

    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

    const records = sentRecords();
    expect(records.map((r) => r.tab.contentType)).toEqual(["terminal", "transfer-view"]);
    expect(records[1].tab.transferViewMeta?.remoteTabId).toBe("t-term");

    const tabs = hydrateInFreshWindow(records);
    const terminal = tabs.find((t) => t.contentType === "terminal");
    const view = tabs.find((t) => t.contentType === "transfer-view");
    expect(terminal?.sessionId).toBe("s1");
    expect(terminal?.id).not.toBe("t-term");
    expect(view?.transferViewMeta).toEqual({
      remoteTabId: terminal!.id,
      localPath: "/home/me",
      remotePath: "/srv/app",
    });
    expect(view?.title).toBe("Transfer: build");
  });

  it("keeps the pairing when the move opens a new window seeded with the terminal", async () => {
    seedTabs([TERMINAL, PAIRED_VIEW]);

    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "new" });

    const records = [openWindow.mock.calls[0][0] as TabHandoffRecord, ...sentRecords()];
    const tabs = hydrateInFreshWindow(records);
    const terminal = tabs.find((t) => t.contentType === "terminal");
    const view = tabs.find((t) => t.contentType === "transfer-view");
    expect(view?.transferViewMeta?.remoteTabId).toBe(terminal!.id);
  });

  it("opens the view unpaired, local side intact, when its terminal does not move", async () => {
    // A terminal without a live session stays behind.
    seedTabs([{ ...TERMINAL, sessionId: null }, PAIRED_VIEW]);

    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

    const records = sentRecords();
    expect(records.map((r) => r.tab.contentType)).toEqual(["transfer-view"]);
    expect(records[0].tab.transferViewMeta?.remoteTabId).toBeNull();

    const [view] = hydrateInFreshWindow(records);
    expect(view.transferViewMeta).toEqual({
      remoteTabId: null,
      localPath: "/home/me",
      remotePath: "/srv/app",
    });
    expect(view.title).toBe("File Transfer");
  });

  it("flags only a transfer view whose terminal stays behind as unpaired", async () => {
    const orphan = staticTab("tv2", "Transfer: gone", {
      contentType: "transfer-view",
      transferViewMeta: { remoteTabId: "t-gone" },
    });
    const free = staticTab("tv3", "File Transfer", {
      contentType: "transfer-view",
      transferViewMeta: { remoteTabId: null },
    });
    seedTabs([TERMINAL, PAIRED_VIEW, orphan, free]);

    await useAppStore.getState().prepareWindowClose(OTHERS);

    const rows = useAppStore.getState().pendingWindowClose?.otherTabs;
    expect(rows?.map((row) => [row.tabId, row.movable, row.unpaired])).toEqual([
      ["tv", true, undefined],
      ["tv2", true, true],
      ["tv3", true, undefined],
    ]);
  });

  it("never pairs a view with a terminal from another move batch", async () => {
    seedTabs([TERMINAL, PAIRED_VIEW]);
    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });
    const [terminalRecord, viewRecord] = sentRecords();

    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.getState().hydrateHandoffTab(terminalRecord);
    // The same view arriving outside its batch (a single-tab move carries none).
    const { moveBatchId: _batch, sourceTabId: _source, ...lone } = viewRecord.tab;
    useAppStore.getState().hydrateHandoffTab({ tab: lone });

    const view = collectWindowTabs(useAppStore.getState()).find(
      (t) => t.contentType === "transfer-view"
    );
    expect(view?.transferViewMeta?.remoteTabId).toBeNull();
    expect(view?.transferViewMeta?.localPath).toBe("/home/me");
  });
});

describe("appStore — Move tabs carries unsaved form editors (#4500)", () => {
  const connEditor = MOVABLE_TABS.find((t) => t.contentType === "connection-editor")!;
  const tunnelEditor = MOVABLE_TABS.find((t) => t.contentType === "tunnel-editor")!;
  const workspaceEditor = MOVABLE_TABS.find((t) => t.contentType === "workspace-editor")!;

  const CONN_DRAFT = {
    selectedType: "ssh",
    connSettings: { host: "db.internal", username: "ops", authMethod: "password", password: "" },
    topLevel: { name: "prod-db (edited)" },
  };
  const TUNNEL_DRAFT = { name: "db tunnel", sshConnectionId: "conn-1", autoStart: true };
  const WORKSPACE_DRAFT = { name: "Ops", description: "on-call", activeGroupIndex: 0 };

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    clearEditorBuffers();
    openWindow.mockReset().mockResolvedValue("win-9");
    sendHandoffToWindow.mockReset().mockResolvedValue(undefined);
  });

  /** Seed the three form editors dirty, each with a registered draft provider. */
  function seedDirtyFormEditors(connClearedSecrets?: string[]): void {
    seedTabs([connEditor, tunnelEditor, workspaceEditor]);
    registerFormDraft(connEditor.id, () => ({
      kind: "connection-editor",
      values: CONN_DRAFT,
      ...(connClearedSecrets ? { clearedSecrets: connClearedSecrets } : {}),
    }));
    registerFormDraft(tunnelEditor.id, () => ({ kind: "tunnel-editor", values: TUNNEL_DRAFT }));
    registerFormDraft(workspaceEditor.id, () => ({
      kind: "workspace-editor",
      values: WORKSPACE_DRAFT,
    }));
    for (const tab of [connEditor, tunnelEditor, workspaceEditor]) {
      useAppStore.getState().setEditorDirty(tab.id, true);
    }
  }

  it("lists dirty form editors with a draft as movable, naming the secrets left behind", async () => {
    seedDirtyFormEditors(["Password"]);

    await useAppStore.getState().prepareWindowClose(OTHERS);

    expect(useAppStore.getState().pendingWindowClose?.dirtyEditors).toEqual([
      { tabId: "ce", title: "Edit server-1", movable: true, clearedSecrets: ["Password"] },
      { tabId: "te", title: "Edit tunnel", movable: true },
      { tabId: "we", title: "Edit workspace", movable: true },
    ]);
  });

  it("a dirty connection, tunnel and workspace editor each reappears dirty with its values", async () => {
    seedDirtyFormEditors(["Password"]);

    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

    const records = sentRecords();
    expect(records.map((r) => r.tab.formDraft)).toEqual([
      { kind: "connection-editor", values: CONN_DRAFT },
      { kind: "tunnel-editor", values: TUNNEL_DRAFT },
      { kind: "workspace-editor", values: WORKSPACE_DRAFT },
    ]);
    expect(records.every((r) => r.tab.editorDirty === true)).toBe(true);

    const tabs = hydrateInFreshWindow(records);

    const byType = (type: string) => tabs.find((t) => t.contentType === type)!;
    const conn = byType("connection-editor");
    const tunnel = byType("tunnel-editor");
    const workspace = byType("workspace-editor");
    expect(conn.connectionEditorMeta).toEqual(connEditor.connectionEditorMeta);
    expect(tunnel.tunnelEditorMeta).toEqual(tunnelEditor.tunnelEditorMeta);
    expect(workspace.workspaceEditorMeta).toEqual(workspaceEditor.workspaceEditorMeta);
    for (const tab of [conn, tunnel, workspace]) {
      expect(useAppStore.getState().editorDirtyTabs[tab.id]).toBe(true);
      // Nothing about the draft is stored in the tab itself, so it is never persisted.
      expect(JSON.stringify(tab)).not.toContain("db.internal");
    }
    // Each draft waits for the editor that mounts for its new tab, and only that kind.
    expect(peekCarriedFormDraft(conn.id, "connection-editor")).toEqual(CONN_DRAFT);
    expect(peekCarriedFormDraft(conn.id, "tunnel-editor")).toBeNull();
    expect(peekCarriedFormDraft(tunnel.id, "tunnel-editor")).toEqual(TUNNEL_DRAFT);
    expect(peekCarriedFormDraft(workspace.id, "workspace-editor")).toEqual(WORKSPACE_DRAFT);
  });

  it("never puts a typed secret into the hand-off, even if an editor's draft holds one", async () => {
    seedTabs([connEditor]);
    registerFormDraft(connEditor.id, () => ({
      kind: "connection-editor",
      values: {
        selectedType: "ssh",
        connSettings: {
          host: "db.internal",
          password: "hunter2",
          keyPassphrase: "open sesame",
          savePassword: true,
          proxyJump: [{ host: "bastion", username: "ops", password: "hop-secret" }],
        },
        topLevel: { name: "prod-db" },
      },
    }));
    useAppStore.getState().setEditorDirty(connEditor.id, true);

    await useAppStore.getState().prepareWindowClose(OTHERS);
    expect(useAppStore.getState().pendingWindowClose?.dirtyEditors?.[0].clearedSecrets).toEqual([
      "Password",
      "Key passphrase",
      "Jump host password",
    ]);

    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

    const [record] = sentRecords();
    const wire = JSON.stringify(record);
    for (const secret of ["hunter2", "open sesame", "hop-secret"]) {
      expect(wire).not.toContain(secret);
    }
    expect(record.tab.formDraft?.values).toEqual({
      selectedType: "ssh",
      connSettings: {
        host: "db.internal",
        password: "",
        keyPassphrase: "",
        savePassword: true,
        proxyJump: [{ host: "bastion", username: "ops", password: "" }],
      },
      topLevel: { name: "prod-db" },
    });
    // The labels are for this window's dialog only; they never travel.
    expect(record.tab.formDraft?.clearedSecrets).toBeUndefined();
  });

  it("moves a clean form editor without a draft", async () => {
    seedTabs([connEditor]);
    // A clean editor's provider returns null.
    registerFormDraft(connEditor.id, () => null);

    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

    const [record] = sentRecords();
    expect(record.tab.formDraft).toBeUndefined();
    expect(record.tab.editorDirty).toBeUndefined();
    expect(readFormDraft(connEditor.id)).toBeNull();
  });

  it("moves an unsaved Settings panel dirty with its values instead of blocking (#4758)", async () => {
    const settingsTab = MOVABLE_TABS.find((t) => t.contentType === "settings")!;
    const SETTINGS_DRAFT = { version: "1", fontSize: 18, apiToken: "" };
    seedTabs([settingsTab]);
    registerFormDraft(settingsTab.id, () => ({
      kind: "settings",
      values: SETTINGS_DRAFT,
      clearedSecrets: ["API token"],
    }));
    useAppStore.getState().setEditorDirty(settingsTab.id, true);

    await useAppStore.getState().prepareWindowClose(OTHERS);
    expect(useAppStore.getState().pendingWindowClose?.dirtyEditors).toEqual([
      { tabId: "st", title: "Settings", movable: true, clearedSecrets: ["API token"] },
    ]);

    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

    const [record] = sentRecords();
    expect(record.tab.formDraft).toEqual({ kind: "settings", values: SETTINGS_DRAFT });
    expect(record.tab.editorDirty).toBe(true);

    const [tab] = hydrateInFreshWindow([record]);
    expect(tab.contentType).toBe("settings");
    expect(useAppStore.getState().editorDirtyTabs[tab.id]).toBe(true);
    expect(peekCarriedFormDraft(tab.id, "settings")).toEqual(SETTINGS_DRAFT);
  });

  it("ignores a draft whose kind does not match the tab", async () => {
    seedTabs([connEditor]);
    registerFormDraft(connEditor.id, () => ({ kind: "tunnel-editor", values: TUNNEL_DRAFT }));
    useAppStore.getState().setEditorDirty(connEditor.id, true);

    await expect(
      useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" })
    ).rejects.toThrow(/Edit server-1/);
  });
});
