/**
 * Tests for file multi-download (PROD-005).
 *
 * Selecting several entries and choosing "Download" from the multi-select
 * context menu must enqueue a download for each selected entry by reusing the
 * existing single-download path (local Save-as → `local_copy`), passing
 * `isDirectory` through so a selected directory recurses the same way the
 * single download does. No new transfer plumbing is introduced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import { seedLayoutState } from "@/test/layoutState";

// The local download Save-as dialog; defaults to a chosen path so the copy runs.
const saveMock = vi.fn((): Promise<string | null> => Promise.resolve("/downloads/out"));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: () => saveMock(),
}));

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

const entries = [
  { name: "a.txt", path: "/home/a.txt", isDirectory: false, size: 1, modified: "" },
  { name: "sub", path: "/home/sub", isDirectory: true, size: 0, modified: "" },
  { name: "b.txt", path: "/home/b.txt", isDirectory: false, size: 1, modified: "" },
];

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

/** Read the `srcPath` field from an invoke args payload, tolerating its union type. */
function argSrcPath(args?: InvokeArgs): string | undefined {
  if (args && typeof args === "object" && "srcPath" in args) {
    return (args as Record<string, unknown>).srcPath as string;
  }
  return undefined;
}

setupFileBrowsersRegion();
// Size the virtualized list so its rows mount under jsdom (MOCK-008).
setupVirtualListSizing();

describe("FileBrowser — multi-download (PROD-005)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    saveMock.mockClear();
    saveMock.mockImplementation(() => Promise.resolve("/downloads/out"));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("enqueues a download for every selected entry, recursing a selected directory", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(entries);
      return Promise.resolve(undefined);
    });

    await renderLocal();

    // Select a file, a directory, and another file.
    await act(async () => {
      row("a.txt").click();
    });
    await act(async () => {
      row("sub").dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });
    await act(async () => {
      row("b.txt").dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });

    // Open the multi-select context menu and trigger the multi-download.
    await act(async () => {
      row("b.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await act(async () => {
      q("multi-select-download").click();
    });
    await flushAsync();
    await flushAsync();

    // Each selected entry reused the single-download path (Save-as + local_copy).
    const copyCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "local_copy");
    expect(copyCalls).toHaveLength(3);
    const bySrc = new Map(copyCalls.map(([, args]) => [argSrcPath(args), args]));
    expect(new Set(bySrc.keys())).toEqual(new Set(["/home/a.txt", "/home/sub", "/home/b.txt"]));

    // The selected directory recurses via the same isDirectory flag the single
    // download uses; files download as files.
    expect((bySrc.get("/home/sub") as Record<string, unknown>).isDirectory).toBe(true);
    expect((bySrc.get("/home/a.txt") as Record<string, unknown>).isDirectory).toBe(false);
    expect((bySrc.get("/home/b.txt") as Record<string, unknown>).isDirectory).toBe(false);
  });

  it("downloads nothing when the Save-as dialog is cancelled for every entry", async () => {
    saveMock.mockImplementation(() => Promise.resolve(null));
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(entries);
      return Promise.resolve(undefined);
    });

    await renderLocal();

    await act(async () => {
      row("a.txt").click();
    });
    await act(async () => {
      row("b.txt").dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });
    await act(async () => {
      row("b.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await act(async () => {
      q("multi-select-download").click();
    });
    await flushAsync();

    expect(mockedInvoke).not.toHaveBeenCalledWith("local_copy", expect.anything());
  });
});
