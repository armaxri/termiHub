import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { flushAsync } from "@/test/flushAsync";
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

setupSettingsRegion();
setupAgentsRegion();
setupFileBrowsersRegion();

// Fixed date so the absolute-timestamp tooltip is deterministic (mid-January
// never crosses a year boundary regardless of the test machine's timezone).
const FIXED_MODIFIED = "2026-01-15T10:30:00Z";

// The listing entries. `unknown.dat` deliberately omits `size` to exercise the
// missing-size guard; the cast models a backend payload that never populated it.
const rowEntries = [
  {
    name: "bigfile.bin",
    path: "/home/bigfile.bin",
    isDirectory: false,
    size: 1536, // → "1.5 KB"
    modified: FIXED_MODIFIED,
    permissions: "-rw-r--r--",
    writable: true,
  },
  {
    name: "unknown.dat",
    path: "/home/unknown.dat",
    isDirectory: false,
    // size intentionally absent
    modified: FIXED_MODIFIED,
    permissions: "-rw-r--r--",
    writable: true,
  } as unknown as {
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    modified: string;
    permissions: string;
    writable: boolean;
  },
  {
    name: "adir",
    path: "/home/adir",
    isDirectory: true,
    size: 0,
    modified: FIXED_MODIFIED,
    permissions: "drwxr-xr-x",
    writable: true,
  },
];

describe("FileBrowser – row meta (size / tooltips) (#2798)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(rowEntries);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function renderLocalAt(path: string) {
    const localTab = makeTab({ connectionType: "local", config: { type: "local", config: {} } });
    setActiveTab(localTab);
    useAppStore.setState({ sidebarView: "files", tabCwds: { "tab-1": path } });
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();
  }

  it("renders a real byte size on the meta line for a file", async () => {
    await renderLocalAt("/home");
    const size = container.querySelector(
      '[data-testid="file-row-bigfile.bin"] .file-browser__size'
    );
    expect(size?.textContent).toBe("1.5 KB");
    // The size sits inside the second-line meta group, not loose in the row.
    expect(size?.closest(".file-browser__meta")).toBeTruthy();
  });

  it("does not render a size (no NaN) for a file with an unknown size", async () => {
    await renderLocalAt("/home");
    const unknownRow = container.querySelector('[data-testid="file-row-unknown.dat"]');
    expect(unknownRow).toBeTruthy();
    // No size cell is rendered when the size is unknown …
    expect(unknownRow?.querySelector(".file-browser__size")).toBeNull();
    // … and nothing in the browser ever renders the "NaN" garbage (#2798).
    expect(container.textContent).not.toContain("NaN");
  });

  it("renders no size cell and no dangling separator for a directory", async () => {
    await renderLocalAt("/home");
    const dirRow = container.querySelector('[data-testid="file-row-adir"]');
    expect(dirRow).toBeTruthy();
    // Directory: Modified · permissions — no Size, and exactly one middot (never a
    // dangling/leading "·" from the missing Size part) (#2798).
    expect(dirRow?.querySelector(".file-browser__size")).toBeNull();
    const meta = dirRow?.querySelector(".file-browser__meta");
    expect(meta?.querySelectorAll(".file-browser__meta-sep").length).toBe(1);
    const metaText = (meta?.textContent ?? "").trim();
    expect(metaText.startsWith("·")).toBe(false);
    expect(metaText.endsWith("·")).toBe(false);
  });

  it("renders permissions on the meta line when present", async () => {
    await renderLocalAt("/home");
    const perms = container.querySelector(
      '[data-testid="file-row-bigfile.bin"] .file-browser__permissions'
    );
    expect(perms?.textContent).toBe("-rw-r--r--");
    expect(perms?.closest(".file-browser__meta")).toBeTruthy();
  });

  it("sets the full filename as the name tooltip", async () => {
    await renderLocalAt("/home");
    const name = container.querySelector(
      '[data-testid="file-row-bigfile.bin"] .file-browser__name'
    );
    expect(name?.getAttribute("title")).toBe("bigfile.bin");
    // The name is on the first line, above the meta line.
    expect(name?.closest(".file-browser__name-line")).toBeTruthy();
  });

  it("sets an absolute timestamp as the Modified tooltip", async () => {
    await renderLocalAt("/home");
    const modified = container.querySelector(
      '[data-testid="file-row-bigfile.bin"] .file-browser__modified'
    );
    const title = modified?.getAttribute("title");
    expect(title).toBeTruthy();
    // The absolute timestamp is localized but always carries the full year.
    expect(title).toContain("2026");
  });
});
