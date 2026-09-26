/**
 * The file browser's "Open Dual-Pane Transfer View" toolbar action (PROD-007,
 * #3558) opens the transfer view attached to the tab that owns the browsed
 * session, seeded with the folder shown in the sidebar.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
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

describe("FileBrowser — open transfer view (#3558)", () => {
  const openTransferViewTab = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ openTransferViewTab });
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

  async function openFrom(render: () => Promise<void>) {
    await render();
    await act(async () => {
      q("file-browser-open-transfer-view")!.click();
    });
  }

  it("attaches the view to the tab owning the browsed session", async () => {
    await openFrom(renderSession);
    expect(openTransferViewTab).toHaveBeenCalledWith(
      expect.objectContaining({ remoteTabId: "tab-1", localPath: undefined })
    );
  });

  it("opens with no remote and the local folder from a local tab", async () => {
    await openFrom(renderLocal);
    expect(openTransferViewTab).toHaveBeenCalledWith({
      remoteTabId: null,
      localPath: "/home",
      remotePath: undefined,
    });
  });
});
