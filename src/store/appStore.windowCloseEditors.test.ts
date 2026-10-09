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

import { useAppStore } from "./appStore";
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
