/**
 * Regression tests for file multi-delete outcome reporting (#1394).
 *
 * The multi-delete path must use `Promise.allSettled` so a partial failure
 * never hides which items actually deleted, and it must surface the per-item
 * outcome via the shared toast API ("Deleted N items, M failed: <names>").
 * A single-delete failure must likewise be surfaced (error toast) instead of
 * failing silently.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { fakeBackend, type CommandHandlers, type FakeBackend } from "@/test/fakeBackend";
import { FILE_BROWSER_MOUNT, LOCAL_FILE_ACTIONS_OK } from "@/test/fileBrowserBackend";
import type { FileEntry } from "@/types/generated/FileEntry";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import { seedLayoutState } from "@/test/layoutState";

const toastSuccess = vi.fn();
const toastError = vi.fn();

// Mock the Toast module itself (not the @/components/ui barrel) so the toast
// calls made from FileBrowser are captured regardless of import path.
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

let backend: FakeBackend;

/** Install the typed fake backend (#6151) with the browser's mount calls under `handlers`. */
function installBackend(handlers: CommandHandlers): FakeBackend {
  backend = fakeBackend({ ...FILE_BROWSER_MOUNT, ...LOCAL_FILE_ACTIONS_OK, ...handlers });
  return backend;
}

let container: HTMLDivElement;
let root: Root;

const file = (name: string): FileEntry => ({
  name,
  path: `/home/${name}`,
  isDirectory: false,
  size: 1,
  modified: "",
  permissions: null,
  writable: null,
});

const entries = [file("a.txt"), file("b.txt"), file("c.txt")];

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

async function renderLocal() {
  setActiveTab(makeTab({ connectionType: "local", config: { type: "local", config: {} } }));
  useAppStore.setState({ sidebarView: "files", tabCwds: { "tab-1": "/home" } });
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <FileBrowser />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

function row(name: string): HTMLElement {
  return container.querySelector(`[data-testid="file-row-${name}"]`) as HTMLElement;
}

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;

setupFileBrowsersRegion();
// Size the virtualized list so its rows mount under jsdom (MOCK-008).
setupVirtualListSizing();

describe("FileBrowser — multi-delete outcome reporting (#1394)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("reports surviving deletions and lists failures when a batch partially fails", async () => {
    // b.txt fails to delete; a.txt and c.txt succeed.
    installBackend({
      local_list_dir: () => entries,
      local_delete: ({ path }) => {
        if (path === "/home/b.txt") throw new Error("permission denied");
      },
    });

    await renderLocal();

    // Select all three rows.
    await act(async () => {
      row("a.txt").click();
    });
    await act(async () => {
      row("b.txt").dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });
    await act(async () => {
      row("c.txt").dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });

    // Open the context menu on a selected row and trigger the multi-delete.
    await act(async () => {
      row("b.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await act(async () => {
      q("multi-select-delete").click();
    });

    // Confirm the destructive-action dialog.
    await act(async () => {
      q("confirm-delete-confirm").click();
    });
    await flushAsync();

    // All three deletes were attempted (Promise.allSettled, not Promise.all).
    const deleteCalls = backend.callsTo("local_delete");
    expect(deleteCalls).toHaveLength(3);

    // A single summary error toast reports the two successes and names the failure.
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    const message = String(toastError.mock.calls[0][0]);
    expect(message).toContain("2");
    expect(message).toContain("1 failed");
    expect(message).toContain("b.txt");
  });

  it("raises no toast when every item in the batch deletes (#5859)", async () => {
    installBackend({
      local_list_dir: () => entries,
    });

    await renderLocal();

    await act(async () => {
      row("a.txt").click();
    });
    await act(async () => {
      row("b.txt").dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });

    await act(async () => {
      row("a.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await act(async () => {
      q("multi-select-delete").click();
    });
    await act(async () => {
      q("confirm-delete-confirm").click();
    });
    await flushAsync();

    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("surfaces a single-delete failure via an error toast instead of failing silently", async () => {
    installBackend({
      local_list_dir: () => entries,
      local_delete: ({ path }) => {
        if (path === "/home/a.txt") throw new Error("permission denied");
      },
    });

    await renderLocal();

    await act(async () => {
      row("a.txt").click();
    });

    // Single-selection context menu → delete.
    await act(async () => {
      row("a.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await act(async () => {
      q("context-file-delete").click();
    });
    await act(async () => {
      q("confirm-delete-confirm").click();
    });
    await flushAsync();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).toContain("a.txt");
  });
});
