/**
 * UX-020: the in-browser transfer footer must offer the SAME control language
 * as the docked Transfer Queue panel, not a divergent one. Its Cancel control
 * routes through the shared `useTransferControls` handler (the region
 * `transfer_cancel` command + the same success/no-op/error toasts) rather than
 * the old bespoke danger button wired to a different code path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion, seedFileBrowsers } from "@/test/fileBrowsersRegionTestHarness";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import type { TransferState } from "@/types/connection";
import { seedLayoutState } from "@/test/layoutState";

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();

vi.mock("@/components/ui/Toast", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/ui/Toast")>("@/components/ui/Toast");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      info: (...args: unknown[]) => toastInfo(...args),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onDragDropEvent: vi.fn(() => Promise.resolve(vi.fn())) }),
}));

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

vi.mock("@/services/events", () => ({
  onVscodeEditComplete: vi.fn(() => Promise.resolve(vi.fn())),
  onLocalDirChanged: vi.fn(() => Promise.resolve(vi.fn())),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return { ...actual, getHomeDir: vi.fn(() => Promise.resolve("/home/test")) };
});

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

function makeTab(overrides: Partial<TerminalTab>): TerminalTab {
  return {
    id: "tab-1",
    sessionId: "ssh-sess-1",
    title: "Test Tab",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "example.com", port: 22, username: "root" } },
    panelId: "panel-1",
    isActive: true,
    ...overrides,
  };
}

function setActiveTab(tab: TerminalTab) {
  const panel: LeafPanel = { type: "leaf", id: tab.panelId, tabs: [tab], activeTabId: tab.id };
  seedLayoutState({ activePanelId: tab.panelId, rootPanel: panel });
}

function setFileBrowserCapableType(typeId: string, displayName: string) {
  useAppStore.setState({
    connectionTypes: [
      {
        typeId,
        displayName,
        icon: "folder",
        schema: { groups: [] },
        capabilities: { monitoring: false, fileBrowser: true, resize: false, persistent: false },
      },
    ],
  });
}

const activeTransfer: TransferState = {
  transferId: "t1",
  sessionId: "ssh-sess-1",
  direction: "download",
  fileName: "big.iso",
  transferred: 50,
  total: 100,
  phase: "transferring",
};

setupFileBrowsersRegion();

describe("FileBrowser — in-browser transfer footer uses the shared controls (UX-020)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    toastSuccess.mockClear();
    toastError.mockClear();
    toastInfo.mockClear();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "session_has_exec_capability") return Promise.resolve(true);
      if (cmd === "session_list_files") return Promise.resolve([]);
      if (cmd === "transfer_cancel") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderSessionWithTransfer() {
    setActiveTab(makeTab({}));
    setFileBrowserCapableType("ssh", "SSH");
    useAppStore.setState({ sidebarView: "files", transfers: { t1: activeTransfer } });
    seedFileBrowsers({
      mode: "session",
      session: { path: "/remote", entries: [], loading: false, error: null },
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

  it("renders the footer transfer row for the active session", async () => {
    await renderSessionWithTransfer();
    const rows = container.querySelectorAll('[data-testid="file-browser-transfer"]');
    expect(rows.length).toBe(1);
    expect(container.textContent).toContain("big.iso");
  });

  it("cancels via the shared control (region transfer_cancel + success toast)", async () => {
    await renderSessionWithTransfer();
    const cancelBtn = container.querySelector(
      '[data-testid="transfer-cancel"]'
    ) as HTMLButtonElement;
    expect(cancelBtn).toBeTruthy();

    await act(async () => {
      cancelBtn.click();
    });
    await flushAsync();

    expect(mockedInvoke).toHaveBeenCalledWith("transfer_cancel", { transferId: "t1" });
    expect(toastSuccess).toHaveBeenCalledWith("Transfer cancelled");
    expect(toastError).not.toHaveBeenCalled();
  });
});
