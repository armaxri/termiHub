import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

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

const quitWindowReady = vi.fn();
const quitWindowPrompting = vi.fn();
const cancelQuit = vi.fn();
const closeTerminal = vi.fn();
const detachPersistentTab = vi.fn();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  quitWindowReady: (...args: unknown[]) => quitWindowReady(...args),
  quitWindowPrompting: (...args: unknown[]) => quitWindowPrompting(...args),
  cancelQuit: (...args: unknown[]) => cancelQuit(...args),
  closeTerminal: (...args: unknown[]) => closeTerminal(...args),
  detachPersistentTab: (...args: unknown[]) => detachPersistentTab(...args),
}));

const destroy = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ destroy, label: "main" }),
}));

import { useAppStore } from "@/store/appStore";
import { CloseWindowDecisionDialog } from "@/components/Terminal/CloseWindowDecisionDialog";
import { handleAppQuitCancelled, handleAppQuitRequested } from "./useAppQuitRequests";

function seedLiveTab(sessionId: string, persistentConnectionId?: string): string {
  return useAppStore.getState().addTab("build", "local", undefined, {
    sessionId,
    ...(persistentConnectionId ? { persistentConnectionId } : {}),
  });
}

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;

let container: HTMLDivElement;
let root: Root;

function renderDialog() {
  act(() => root.render(<CloseWindowDecisionDialog />));
}

describe("app quit request (#4296)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    quitWindowReady.mockReset().mockResolvedValue(undefined);
    quitWindowPrompting.mockReset().mockResolvedValue(undefined);
    cancelQuit.mockReset().mockResolvedValue(undefined);
    closeTerminal.mockReset().mockResolvedValue(undefined);
    detachPersistentTab.mockReset().mockResolvedValue(undefined);
    destroy.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("confirms the quit at once when nothing would be lost", async () => {
    await handleAppQuitRequested();

    expect(quitWindowReady).toHaveBeenCalledTimes(1);
    expect(quitWindowPrompting).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingWindowClose).toBeNull();
  });

  it("confirms without detaching when every session is persistent", async () => {
    seedLiveTab("s1", "conn-1");

    await handleAppQuitRequested();

    expect(quitWindowReady).toHaveBeenCalledTimes(1);
    expect(detachPersistentTab).not.toHaveBeenCalled();
  });

  it("opens the decision dialog for a live non-persistent session and confirms back", async () => {
    seedLiveTab("s1");
    renderDialog();

    await act(async () => {
      await handleAppQuitRequested();
    });

    expect(quitWindowPrompting).toHaveBeenCalledTimes(1);
    expect(quitWindowReady).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingWindowClose?.mode).toBe("quit");
    expect(q("close-window-decision-dialog")).not.toBeNull();
    // A quit has no other window to move tabs into.
    expect(q("close-window-decision-move")).toBeNull();

    await act(async () => {
      q("close-window-decision-end").click();
    });

    expect(quitWindowReady).toHaveBeenCalledTimes(1);
    // The backend exits the whole app; the window is not destroyed on its own.
    expect(destroy).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingWindowClose).toBeNull();
  });

  it("prompts for an unsaved editor", async () => {
    const tabId = useAppStore
      .getState()
      .addTab("nginx.conf", "local", undefined, { contentType: "editor" });
    useAppStore.getState().setEditorDirty(tabId, true);

    await handleAppQuitRequested();

    expect(quitWindowPrompting).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().pendingWindowClose?.dirtyEditors).toEqual([
      { tabId, title: "nginx.conf" },
    ]);
  });

  it("does not raise a second prompt for a repeated quit request", async () => {
    seedLiveTab("s1");
    await handleAppQuitRequested();
    const first = useAppStore.getState().pendingWindowClose;

    await handleAppQuitRequested();

    expect(useAppStore.getState().pendingWindowClose).toBe(first);
    expect(quitWindowReady).not.toHaveBeenCalled();
  });

  it("cancelling the dialog cancels the quit in the backend", async () => {
    seedLiveTab("s1");
    renderDialog();
    await act(async () => {
      await handleAppQuitRequested();
    });

    await act(async () => {
      q("close-window-decision-cancel").click();
    });

    expect(cancelQuit).toHaveBeenCalledTimes(1);
    expect(quitWindowReady).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingWindowClose).toBeNull();
  });

  it("a quit cancelled elsewhere closes this window's quit dialog only", async () => {
    seedLiveTab("s1");
    await handleAppQuitRequested();

    handleAppQuitCancelled();
    expect(useAppStore.getState().pendingWindowClose).toBeNull();

    // A plain window-close dialog is left alone.
    useAppStore.getState().setPendingWindowClose({ sessions: [], otherWindows: [] });
    handleAppQuitCancelled();
    expect(useAppStore.getState().pendingWindowClose).not.toBeNull();
  });
});
