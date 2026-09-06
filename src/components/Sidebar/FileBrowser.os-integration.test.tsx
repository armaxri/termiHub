/**
 * Tests for the file-browser local OS-integration actions (#2656).
 *
 * Two local-only toolbar actions act on the currently-browsed folder
 * (`currentPath`):
 *   1. "Open in File Manager" — opens the OS-native file manager (frontend-only
 *      via `openPath` from `@tauri-apps/plugin-opener`).
 *   2. "Open Folder in VS Code" — opens the folder as a workspace, reusing the
 *      existing `vscode_open_local` plumbing.
 *
 * Both are gated on `mode === "local"`; the VS Code action additionally requires
 * the `vscodeAvailable` store flag. The same actions are also offered as
 * folder-row context items (gated identically) and routed through
 * `handleContextAction`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { FileBrowser, FileMenuItems } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import type { FileEntry } from "@/types/connection";
import { seedLayoutState } from "@/test/layoutState";

const openPath = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: (...args: unknown[]) => openPath(...args),
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@/components/ui/Toast", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/ui/Toast")>("@/components/ui/Toast");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(vi.fn())),
  }),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/events", () => ({
  onVscodeEditComplete: vi.fn(() => Promise.resolve(vi.fn())),
  onLocalDirChanged: vi.fn(() => Promise.resolve(vi.fn())),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    getHomeDir: vi.fn(() => Promise.resolve("/home/test")),
  };
});

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

function makeTab(overrides: Partial<TerminalTab>): TerminalTab {
  return {
    id: "tab-1",
    sessionId: "sess-1",
    title: "Test Tab",
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "panel-1",
    isActive: true,
    ...overrides,
  };
}

function setActiveTab(tab: TerminalTab) {
  const panel: LeafPanel = { type: "leaf", id: tab.panelId, tabs: [tab], activeTabId: tab.id };
  seedLayoutState({ activePanelId: tab.panelId, rootPanel: panel });
}

async function renderLocal({ vscodeAvailable = true } = {}) {
  setActiveTab(makeTab({ connectionType: "local", config: { type: "local", config: {} } }));
  useAppStore.setState({
    sidebarView: "files",
    tabCwds: { "tab-1": "/home" },
    vscodeAvailable,
  });
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <FileBrowser />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

async function renderSession() {
  const ftpTab = makeTab({
    connectionType: "ftp",
    sessionId: "ftp-sess-1",
    config: { type: "ftp", config: { host: "ftp.example.com", port: 21 } },
  });
  setActiveTab(ftpTab);
  useAppStore.setState({
    sidebarView: "files",
    vscodeAvailable: true,
    connectionTypes: [
      {
        typeId: "ftp",
        displayName: "FTP",
        icon: "folder",
        schema: { groups: [] },
        capabilities: { monitoring: false, fileBrowser: true, resize: false, persistent: false },
      },
    ],
  });
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <FileBrowser />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

const q = (testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;

setupFileBrowsersRegion();

describe("FileBrowser — local OS-integration toolbar actions (#2656)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    openPath.mockClear();
    openPath.mockResolvedValue(undefined);
    toastSuccess.mockClear();
    toastError.mockClear();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve([]);
      if (cmd === "session_list_files") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders both OS-integration actions in local mode", async () => {
    await renderLocal();
    expect(q("file-browser-open-in-explorer")).toBeTruthy();
    expect(q("file-browser-open-folder-vscode")).toBeTruthy();
  });

  it("hides both actions in session mode", async () => {
    await renderSession();
    expect(q("file-browser-open-in-explorer")).toBeNull();
    expect(q("file-browser-open-folder-vscode")).toBeNull();
  });

  it("hides the VS Code action when VS Code is unavailable", async () => {
    await renderLocal({ vscodeAvailable: false });
    // The file-manager action does not depend on VS Code.
    expect(q("file-browser-open-in-explorer")).toBeTruthy();
    expect(q("file-browser-open-folder-vscode")).toBeNull();
  });

  it("opens the OS file manager at the current path", async () => {
    await renderLocal();
    await act(async () => {
      q("file-browser-open-in-explorer")!.click();
    });
    await flushAsync();
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(openPath).toHaveBeenCalledWith("/home");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("opens the current folder as a VS Code workspace", async () => {
    await renderLocal();
    await act(async () => {
      q("file-browser-open-folder-vscode")!.click();
    });
    await flushAsync();
    expect(mockedInvoke).toHaveBeenCalledWith("vscode_open_local", { path: "/home" });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast when opening the file manager fails", async () => {
    openPath.mockRejectedValueOnce(new Error("no file manager"));
    await renderLocal();
    await act(async () => {
      q("file-browser-open-in-explorer")!.click();
    });
    await flushAsync();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows an error toast when opening the folder in VS Code fails", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve([]);
      if (cmd === "vscode_open_local") return Promise.reject(new Error("code not found"));
      return Promise.resolve(undefined);
    });
    await renderLocal();
    await act(async () => {
      q("file-browser-open-folder-vscode")!.click();
    });
    await flushAsync();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

/** Renders menu items as plain divs (bypassing Radix portal issues in JSDOM). */
function SimpleItem({
  children,
  onSelect,
  ...rest
}: {
  children: React.ReactNode;
  onSelect?: () => void;
  [key: string]: unknown;
}) {
  return (
    <div role="menuitem" onClick={onSelect} {...rest}>
      {children}
    </div>
  );
}
function SimpleSeparator(props: Record<string, unknown>) {
  return <hr {...props} />;
}

describe("FileBrowser — folder-row OS-integration context items (#2656)", () => {
  const dirEntry: FileEntry = {
    name: "projects",
    path: "/home/user/projects",
    isDirectory: true,
    size: 0,
    modified: "2026-01-01T00:00:00Z",
    permissions: null,
    writable: null,
  };
  const fileEntry: FileEntry = {
    name: "notes.txt",
    path: "/home/user/notes.txt",
    isDirectory: false,
    size: 42,
    modified: "2026-01-01T00:00:00Z",
    permissions: null,
    writable: null,
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function renderMenu(entry: FileEntry, opts: { vscodeAvailable: boolean; local: boolean }) {
    const onAction = vi.fn();
    act(() => {
      root.render(
        <FileMenuItems
          entry={entry}
          vscodeAvailable={opts.vscodeAvailable}
          onNavigate={vi.fn()}
          onContextAction={onAction}
          onPaste={vi.fn()}
          hasClipboard={false}
          onShareVia={opts.local ? vi.fn() : undefined}
          Item={SimpleItem}
          Separator={SimpleSeparator}
          testIdPrefix="file-menu"
        />
      );
    });
    return onAction;
  }

  it("shows both folder OS-integration items for a local directory", () => {
    renderMenu(dirEntry, { vscodeAvailable: true, local: true });
    expect(container.querySelector('[data-testid="file-menu-open-in-explorer"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="file-menu-open-folder-vscode"]')).toBeTruthy();
  });

  it("hides the folder VS Code item when VS Code is unavailable", () => {
    renderMenu(dirEntry, { vscodeAvailable: false, local: true });
    expect(container.querySelector('[data-testid="file-menu-open-in-explorer"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="file-menu-open-folder-vscode"]')).toBeNull();
  });

  it("hides both folder items outside local mode", () => {
    renderMenu(dirEntry, { vscodeAvailable: true, local: false });
    expect(container.querySelector('[data-testid="file-menu-open-in-explorer"]')).toBeNull();
    expect(container.querySelector('[data-testid="file-menu-open-folder-vscode"]')).toBeNull();
  });

  it("does not show the folder items for a file entry", () => {
    renderMenu(fileEntry, { vscodeAvailable: true, local: true });
    expect(container.querySelector('[data-testid="file-menu-open-in-explorer"]')).toBeNull();
    expect(container.querySelector('[data-testid="file-menu-open-folder-vscode"]')).toBeNull();
  });

  it("dispatches openInExplorer when the file-manager item is clicked", () => {
    const onAction = renderMenu(dirEntry, { vscodeAvailable: true, local: true });
    act(() => {
      (
        container.querySelector('[data-testid="file-menu-open-in-explorer"]') as HTMLElement
      ).click();
    });
    expect(onAction).toHaveBeenCalledWith(dirEntry, "openInExplorer");
  });

  it("dispatches openFolderVscode when the VS Code item is clicked", () => {
    const onAction = renderMenu(dirEntry, { vscodeAvailable: true, local: true });
    act(() => {
      (
        container.querySelector('[data-testid="file-menu-open-folder-vscode"]') as HTMLElement
      ).click();
    });
    expect(onAction).toHaveBeenCalledWith(dirEntry, "openFolderVscode");
  });
});
