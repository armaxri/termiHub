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
import type { FileEntry } from "@/types/connection";
import { seedLayoutState } from "@/test/layoutState";

// Capture the OS drag/drop registration so we can assert the container-level
// drop handler still attaches while the row list is virtualized.
const onDragDropEvent = vi.fn(() => Promise.resolve(vi.fn()));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onDragDropEvent }),
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
  const panel: LeafPanel = {
    type: "leaf",
    id: tab.panelId,
    tabs: [tab],
    activeTabId: tab.id,
  };
  seedLayoutState({ activePanelId: tab.panelId, rootPanel: panel });
}

/** Build `count` deterministic, sort-stable file entries (`item-0000`, ...). */
function makeEntries(count: number): FileEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const name = `item-${String(i).padStart(4, "0")}`;
    return {
      name,
      path: `/big/${name}`,
      isDirectory: false,
      size: i,
      modified: "",
      permissions: null,
      writable: null,
    };
  });
}

/** Count mounted file rows (excludes the per-row kebab-menu buttons). */
function mountedRowCount(): number {
  return container.querySelectorAll(
    '[data-testid^="file-row-"]:not([data-testid^="file-row-menu-"])'
  ).length;
}

async function renderLocalBrowser(entries: FileEntry[]) {
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "local_list_dir") return Promise.resolve(entries);
    return Promise.resolve(undefined);
  });
  const localTab = makeTab({ connectionType: "local", config: { type: "local", config: {} } });
  setActiveTab(localTab);
  useAppStore.setState({ sidebarView: "files", tabCwds: { "tab-1": "/big" } });
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <FileBrowser />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

setupFileBrowsersRegion();

describe("FileBrowser – virtualization", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    onDragDropEvent.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("mounts only a windowed subset of a large directory", async () => {
    await renderLocalBrowser(makeEntries(5000));

    const rows = mountedRowCount();
    // Only the visible window (+overscan) should be in the DOM — far fewer than
    // the full 5000. This assertion fails against an eager `.map` render.
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(300);

    // The first entry is in view; the very last is far below and not mounted.
    expect(container.querySelector('[data-testid="file-row-item-0000"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="file-row-item-4999"]')).toBeNull();
  });

  it("registers the container-level OS file-drop handler while virtualized", async () => {
    await renderLocalBrowser(makeEntries(5000));
    // Drag-and-drop is wired on the outer container, not per row, so it must
    // still attach regardless of how few rows are mounted.
    expect(onDragDropEvent).toHaveBeenCalled();
  });

  it("preserves plain, ctrl and shift-range selection over the full data set", async () => {
    // 40 rows fit inside the stubbed 2000px window, so all are mounted.
    await renderLocalBrowser(makeEntries(40));

    const row = (i: number) =>
      container.querySelector(
        `[data-testid="file-row-item-${String(i).padStart(4, "0")}"]`
      ) as HTMLElement;

    act(() => {
      row(2).click();
    });
    expect(container.querySelectorAll(".file-browser__row-wrapper--selected").length).toBe(1);

    act(() => {
      row(6).dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
    });
    // Range 2..6 inclusive = 5 rows, computed from the full display order.
    expect(container.querySelectorAll(".file-browser__row-wrapper--selected").length).toBe(5);

    act(() => {
      row(10).dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });
    expect(container.querySelectorAll(".file-browser__row-wrapper--selected").length).toBe(6);
  });

  it("keeps Ctrl+A selecting the entire (virtualized) directory", async () => {
    await renderLocalBrowser(makeEntries(5000));
    const list = container.querySelector('[data-testid="file-browser-list"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    });
    const indicator = container.querySelector('[data-testid="file-browser-selected-count"]');
    expect(indicator?.textContent).toContain("5000");
  });

  it("scrolls the last row into view and focuses it on End", async () => {
    await renderLocalBrowser(makeEntries(300));

    // The last row starts off-screen (not mounted).
    expect(container.querySelector('[data-testid="file-row-item-0299"]')).toBeNull();

    const list = container.querySelector('[data-testid="file-browser-list"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    await flushAsync();

    // Virtualization must scroll-to-index so the off-screen focus target mounts
    // and receives focus — otherwise roving keyboard focus breaks.
    const lastRow = container.querySelector(
      '[data-testid="file-row-item-0299"]'
    ) as HTMLButtonElement | null;
    expect(lastRow).toBeTruthy();
    expect(document.activeElement).toBe(lastRow);
  });

  it("moves roving focus with ArrowDown while virtualized", async () => {
    await renderLocalBrowser(makeEntries(300));
    const list = container.querySelector('[data-testid="file-browser-list"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await flushAsync();
    const second = container.querySelector(
      '[data-testid="file-row-item-0001"]'
    ) as HTMLButtonElement;
    expect(document.activeElement).toBe(second);
  });

  it("still supports rename-in-place (F2) on the focused row", async () => {
    await renderLocalBrowser(makeEntries(40));
    const list = container.querySelector('[data-testid="file-browser-list"]') as HTMLElement;
    // Focus the first row, then start an inline rename.
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    });
    const input = container.querySelector(
      '[data-testid="file-row-rename-input"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // Cancelling restores the normal row and removes the inline editor.
    expect(container.querySelector('[data-testid="file-row-rename-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="file-row-item-0000"]')).toBeTruthy();
  });
});
