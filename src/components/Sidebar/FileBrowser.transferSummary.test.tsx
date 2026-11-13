/**
 * #5625 (R-028): transfers live in one place — the docked Transfers panel. The
 * file-browser sidebar no longer repeats the list (it squeezed the file list);
 * it shows at most a one-line summary of the browsed session's transfers, read
 * from the same authoritative `transfers` projection region, that opens the
 * panel. (Before #5625 this footer rendered the compact rows, UX-020 / #2905.)
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

describe("FileBrowser — transfer summary instead of a second list (#5625)", () => {
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

  async function renderSessionWithTransfers(entries: TransferEntry[], minimized = false) {
    setActiveTab(makeTab({}));
    setFileBrowserCapableType("ssh", "SSH");
    useAppStore.setState({ sidebarView: "files" });
    transport.seed(transfersView(entries, minimized));
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

  function chip(): HTMLButtonElement | null {
    return container.querySelector('[data-testid="file-browser-transfer-summary"]');
  }

  it("shows a one-line summary instead of a second transfer list", async () => {
    await renderSessionWithTransfers([activeTransfer()]);
    expect(chip()?.textContent).toContain("1 transfer in progress");
    expect(container.querySelector('[data-testid="file-browser-transfers"]')).toBeNull();
    expect(container.querySelector('[data-testid="transfer-row"]')).toBeNull();
    expect(container.querySelector('[data-testid="transfer-cancel"]')).toBeNull();
  });

  it("counts only transfers owned by the browsed session", async () => {
    await renderSessionWithTransfers([
      activeTransfer({ state: "completed", percent: 100, transferred: 100 }),
      fakeTransferEntry("t2", { sessionId: "ssh-sess-1", name: "two.bin", state: "completed" }),
      fakeTransferEntry("t3", { sessionId: "other-sess", name: "elsewhere.bin", state: "active" }),
    ]);
    expect(chip()?.textContent).toContain("2 transfers done");
  });

  it("says when a finished transfer failed", async () => {
    await renderSessionWithTransfers([
      activeTransfer({ state: "completed", percent: 100, transferred: 100 }),
      fakeTransferEntry("t2", { sessionId: "ssh-sess-1", name: "two.bin", state: "failed" }),
    ]);
    expect(chip()?.textContent).toContain("1 transfer failed");
  });

  it("opens the Transfers panel when clicked", async () => {
    await renderSessionWithTransfers([activeTransfer()], true);
    await act(async () => {
      chip()?.click();
    });
    await flushAsync();
    expect(transport.dispatched).toContainEqual(
      expect.objectContaining({ kind: "transfer.setMinimized", payload: { minimized: false } })
    );
  });

  it("renders nothing when the browsed session has no transfers", async () => {
    await renderSessionWithTransfers([
      fakeTransferEntry("t3", { sessionId: "other-sess", name: "elsewhere.bin" }),
    ]);
    expect(chip()).toBeNull();
  });
});
