/**
 * UX-020 / #2905: the in-browser transfer footer is fully consolidated with the
 * docked Transfer Queue panel — it renders from the one authoritative `transfers`
 * projection region (not a divergent transient map) via the shared
 * {@link TransferEntryRow} in its compact variant, so both surfaces share one
 * data source and one row/control component. Its controls route through the
 * shared `useTransferControls` handlers (region commands + the same
 * success/no-op/error toasts), it retains terminal rows, and it offers Remove.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion, seedFileBrowsers } from "@/test/fileBrowsersRegionTestHarness";
import {
  installTransferHarness,
  transfersView,
  fakeTransferEntry,
  type FakeTransferTransport,
} from "@/test/transferHarness";
import { ensureTransfersSubscribed } from "@/store/transfersBridge";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import type { TransferEntry } from "@/types/transfer";
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
let transport: FakeTransferTransport;
let teardown: () => void;

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

/** An active download owned by the browsed session, seeded into the region. */
function activeTransfer(overrides: Partial<TransferEntry> = {}): TransferEntry {
  return fakeTransferEntry("t1", {
    sessionId: "ssh-sess-1",
    direction: "download",
    name: "big.iso",
    state: "active",
    transferred: 50,
    totalBytes: 100,
    percent: 50,
    ...overrides,
  });
}

setupFileBrowsersRegion();

describe("FileBrowser — in-browser transfer footer is region-backed (UX-020 / #2905)", () => {
  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState());
    ({ transport, teardown } = installTransferHarness());
    await ensureTransfersSubscribed();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
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
    teardown();
    vi.clearAllMocks();
  });

  async function renderSessionWithTransfers(entries: TransferEntry[]) {
    setActiveTab(makeTab({}));
    setFileBrowserCapableType("ssh", "SSH");
    useAppStore.setState({ sidebarView: "files" });
    transport.seed(transfersView(entries));
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

  it("renders the shared compact row for the active session's transfer", async () => {
    await renderSessionWithTransfers([activeTransfer()]);
    const rows = container.querySelectorAll('[data-testid="file-browser-transfer"]');
    expect(rows.length).toBe(1);
    expect(container.querySelector('[data-testid="transfer-row"]')).toBeTruthy();
    expect(container.textContent).toContain("big.iso");
  });

  it("shows only transfers owned by the browsed session", async () => {
    await renderSessionWithTransfers([
      activeTransfer(),
      fakeTransferEntry("t2", { sessionId: "other-sess", name: "elsewhere.bin" }),
    ]);
    const rows = container.querySelectorAll('[data-testid="file-browser-transfer"]');
    expect(rows.length).toBe(1);
    expect(container.textContent).toContain("big.iso");
    expect(container.textContent).not.toContain("elsewhere.bin");
  });

  it("cancels via the shared control (region transfer_cancel + success toast)", async () => {
    await renderSessionWithTransfers([activeTransfer()]);
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

  it("retains a terminal (completed) row and offers Remove, dispatching transfer.remove", async () => {
    await renderSessionWithTransfers([
      activeTransfer({ state: "completed", percent: 100, transferred: 100 }),
    ]);
    // Terminal rows are now retained (single source of truth), unlike the old
    // transient footer that cleared on completion.
    expect(container.querySelector('[data-testid="file-browser-transfer"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="transfer-cancel"]')).toBeNull();
    const removeBtn = container.querySelector(
      '[data-testid="transfer-remove"]'
    ) as HTMLButtonElement;
    expect(removeBtn).toBeTruthy();

    await act(async () => {
      removeBtn.click();
    });
    await flushAsync();

    expect(transport.kinds()).toContain("transfer.remove");
    // The region fold drops the row, so the footer empties.
    expect(container.querySelector('[data-testid="file-browser-transfer"]')).toBeNull();
  });

  // #3304: SFTP transfers support pause/resume/retry since PROD-0012.
  it("shows Pause for an SSH/SFTP footer transfer alongside Cancel", async () => {
    await renderSessionWithTransfers([activeTransfer()]);
    expect(container.querySelector('[data-testid="transfer-pause"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="transfer-cancel"]')).toBeTruthy();
  });
});
