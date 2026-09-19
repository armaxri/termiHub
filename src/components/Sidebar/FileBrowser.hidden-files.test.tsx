/**
 * Tests for the file browser show/hide hidden-files toggle (PROD-008).
 *
 * Dot-prefixed entries are hidden by default (the standard file-explorer
 * default). The toolbar toggle reveals them, and its state is persisted on the
 * layout config so it survives restarts alongside the other view prefs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import { seedLayoutState } from "@/test/layoutState";

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
  { name: ".bashrc", path: "/home/.bashrc", isDirectory: false, size: 1, modified: "" },
  { name: "visible.txt", path: "/home/visible.txt", isDirectory: false, size: 1, modified: "" },
  { name: ".config", path: "/home/.config", isDirectory: true, size: 0, modified: "" },
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

function row(name: string): HTMLElement | null {
  return container.querySelector(`[data-testid="file-row-${name}"]`);
}

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;

setupFileBrowsersRegion();
setupVirtualListSizing();

describe("FileBrowser — hidden-files toggle (PROD-008)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(entries);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("hides dot-prefixed entries by default and reveals them on toggle", async () => {
    await renderLocal();

    // Default: dotfiles hidden, non-dot entry visible.
    expect(row("visible.txt")).not.toBeNull();
    expect(row(".bashrc")).toBeNull();
    expect(row(".config")).toBeNull();

    // Toggle on.
    await act(async () => {
      q("file-browser-toggle-hidden").click();
    });
    await flushAsync();

    expect(row(".bashrc")).not.toBeNull();
    expect(row(".config")).not.toBeNull();
    expect(row("visible.txt")).not.toBeNull();
  });

  it("persists the toggle state on the layout config", async () => {
    await renderLocal();

    expect(useAppStore.getState().layoutConfig.showHiddenFiles ?? false).toBe(false);

    await act(async () => {
      q("file-browser-toggle-hidden").click();
    });
    await flushAsync();

    // The persisted view-pref field flips on the shared layout config, which is
    // what carries it across restarts.
    expect(useAppStore.getState().layoutConfig.showHiddenFiles).toBe(true);
  });

  it("honours a persisted show-hidden preference on first render", async () => {
    useAppStore.setState((s) => ({
      layoutConfig: { ...s.layoutConfig, showHiddenFiles: true },
    }));

    await renderLocal();

    expect(row(".bashrc")).not.toBeNull();
    expect(row(".config")).not.toBeNull();
  });
});
