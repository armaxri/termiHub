import { readFileSync } from "node:fs";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
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
import { openFileBrowserMoreMenu } from "@/test/fileBrowserMenu";

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
// Size the virtualized list so its rows mount under jsdom (MOCK-008).
setupVirtualListSizing();

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

/** The `.file-browser__row-wrapper` that owns a given row's button + meta overlay. */
function rowWrapper(name: string): Element | null | undefined {
  return container
    .querySelector(`[data-testid="file-row-${name}"]`)
    ?.closest(".file-browser__row-wrapper");
}

/** The row's own button (the option), which now carries the Modified / Size cells. */
function rowButton(name: string): Element | null {
  return container.querySelector(`[data-testid="file-row-${name}"]`);
}

function mountHarness() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState(useAppStore.getInitialState());
}

function unmountHarness() {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
}

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

describe("FileBrowser – Modified / Size columns (#5623, #2798 regression)", () => {
  beforeEach(() => {
    mountHarness();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(rowEntries);
      return Promise.resolve(undefined);
    });
  });

  afterEach(unmountHarness);

  it("renders a real byte size in the row's Size column (not only on hover)", async () => {
    await renderLocalAt("/home");
    const size = rowButton("bigfile.bin")?.querySelector(".file-browser__size");
    expect(size?.textContent).toBe("1.5 KB");
    expect(size?.classList.contains("file-browser__cell")).toBe(true);
  });

  it("renders the Modified column in the row with an absolute-timestamp tooltip", async () => {
    await renderLocalAt("/home");
    const modified = rowButton("bigfile.bin")?.querySelector(".file-browser__modified");
    expect(modified?.classList.contains("file-browser__cell")).toBe(true);
    expect((modified?.textContent ?? "").length).toBeGreaterThan(0);
    // The absolute timestamp is localized but always carries the full year.
    expect(modified?.getAttribute("title")).toContain("2026");
  });

  it("keeps an empty Size cell (no NaN) for a file with an unknown size", async () => {
    await renderLocalAt("/home");
    const size = rowButton("unknown.dat")?.querySelector(".file-browser__size");
    // The cell stays so the columns line up; it is simply blank …
    expect(size?.textContent).toBe("");
    // … and nothing in the browser ever renders the "NaN" garbage (#2798).
    expect(container.textContent).not.toContain("NaN");
  });

  it("leaves the Size cell blank for a directory", async () => {
    await renderLocalAt("/home");
    expect(rowButton("adir")?.querySelector(".file-browser__size")?.textContent).toBe("");
  });

  it("shows the Modified and Size headers when the listing has that data", async () => {
    await renderLocalAt("/home");
    expect(container.querySelector('[data-testid="file-browser-sort-modified"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="file-browser-sort-size"]')).toBeTruthy();
  });

  it("keeps permissions in the hover overlay beside the row button", async () => {
    await renderLocalAt("/home");
    const perms = rowWrapper("bigfile.bin")?.querySelector(".file-browser__permissions");
    expect(perms?.textContent).toBe("-rw-r--r--");
    expect(perms?.closest(".file-browser__meta")).toBeTruthy();
    expect(rowButton("bigfile.bin")?.querySelector(".file-browser__meta")).toBeNull();
    // The overlay no longer duplicates the columns.
    expect(
      rowWrapper("bigfile.bin")?.querySelector(".file-browser__meta .file-browser__size")
    ).toBe(null);
  });

  it("keeps the full filename in the text and in the name tooltip", async () => {
    await renderLocalAt("/home");
    const name = rowButton("bigfile.bin")?.querySelector(".file-browser__name");
    expect(name?.textContent).toBe("bigfile.bin");
    expect(name?.getAttribute("title")).toBe("bigfile.bin");
  });

  it("says whose filesystem it shows: This computer", async () => {
    await renderLocalAt("/home");
    const host = container.querySelector('[data-testid="file-browser-host"]');
    expect(host?.textContent).toContain("This computer");
    expect(host?.getAttribute("data-host-kind")).toBe("local");
  });
});

describe("FileBrowser – no header without its column (#5623)", () => {
  beforeEach(mountHarness);
  afterEach(unmountHarness);

  it("hides Modified and Size when no entry carries a date or a size", async () => {
    const bare = rowEntries.map((e) => ({
      ...e,
      modified: undefined,
      isDirectory: true,
    }));
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(bare);
      return Promise.resolve(undefined);
    });
    await renderLocalAt("/home");
    expect(container.querySelector('[data-testid="file-row-adir"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="file-browser-sort-name"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="file-browser-sort-modified"]')).toBeNull();
    expect(container.querySelector('[data-testid="file-browser-sort-size"]')).toBeNull();
    expect(container.querySelector(".file-browser__modified")).toBeNull();
    expect(container.querySelector(".file-browser__size")).toBeNull();
  });
});

// The regressions here are CSS ones (#2798: the list stopped scrolling; #5623: long
// names spilled past the panel into a horizontal scrollbar), so pin the stylesheet's
// load-bearing rules directly.
describe("FileBrowser.css – truncation + scroll rules (#5623, #2798)", () => {
  // Vitest runs from the repo root, so resolve the stylesheet against cwd.
  const css = readFileSync("src/components/Sidebar/FileBrowser.css", "utf8");

  /** Return the declaration body of `<selector> { ... }` (first match), or "". */
  function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    return match ? match[1] : "";
  }

  it("ellipsizes a long filename instead of spilling past the panel", () => {
    const name = ruleBody(".file-browser__name");
    expect(name).toContain("text-overflow: ellipsis");
    expect(name).toContain("overflow: hidden");
    expect(name).toContain("white-space: nowrap");
    expect(name).toContain("min-width: 0");
  });

  it("scrolls the list vertically only (no horizontal scrollbar)", () => {
    const list = ruleBody(".file-browser__list");
    expect(list).toContain("min-height: 0");
    expect(list).toContain("overflow-y: auto");
    expect(list).toContain("overflow-x: hidden");
  });

  it("hides the Modified / Size headers together with their cells when the panel is narrow", () => {
    expect(ruleBody(".file-browser")).toContain("container-type: inline-size");
    const narrow = css.match(/@container file-browser \(max-width: [^)]+\)\s*\{([\s\S]*?)\n\}/);
    expect(narrow).toBeTruthy();
    const body = narrow?.[1] ?? "";
    for (const sel of [
      ".file-browser__col--modified",
      ".file-browser__col--size",
      ".file-browser__cell",
    ]) {
      expect(body).toContain(sel);
    }
    expect(body).toContain("display: none");
  });

  it("hides the permissions overlay at rest as an absolutely-positioned right overlay", () => {
    const meta = ruleBody(".file-browser__meta");
    expect(meta).toContain("position: absolute");
    expect(meta).toContain("opacity: 0");
    expect(ruleBody(".file-browser__row-wrapper")).toContain("position: relative");
  });

  it("drops the middot separator rule entirely", () => {
    expect(css).not.toContain(".file-browser__meta-sep");
  });
});

describe("FileBrowser – sort by a hidden column (#5671)", () => {
  beforeEach(mountHarness);
  afterEach(unmountHarness);

  async function chooseSort(testId: string) {
    await openFileBrowserMoreMenu();
    const trigger = document.querySelector<HTMLElement>('[data-testid="file-browser-sort-menu"]')!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await act(async () => {
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click();
    });
    await flushAsync();
  }

  it("sorts by size from the menu and names the hidden sort on the Name header", async () => {
    const sized = [
      { ...rowEntries[0], name: "big.bin", path: "/home/big.bin", size: 9000, modified: undefined },
      { ...rowEntries[0], name: "a.txt", path: "/home/a.txt", size: 10, modified: undefined },
      { ...rowEntries[0], name: "mid.txt", path: "/home/mid.txt", size: 500, modified: undefined },
    ];
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(sized);
      return Promise.resolve(undefined);
    });
    await renderLocalAt("/home");
    const order = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>('[role="option"][data-testid^="file-row-"]')
      ).map((r) => r.dataset.testid);
    expect(order()).toEqual(["file-row-a.txt", "file-row-big.bin", "file-row-mid.txt"]);

    await chooseSort("file-browser-sort-by-size");
    expect(order()).toEqual(["file-row-a.txt", "file-row-mid.txt", "file-row-big.bin"]);
    await chooseSort("file-browser-sort-dir-desc");
    expect(order()).toEqual(["file-row-big.bin", "file-row-mid.txt", "file-row-a.txt"]);

    // Size has a column here, so the hint shows only when CSS hides it.
    const hint = container.querySelector('[data-testid="file-browser-sorted-by"]');
    expect(hint?.textContent).toContain("size");
    expect(hint?.classList.contains("file-browser__col-sorted-by--size")).toBe(true);
    expect(hint?.classList.contains("file-browser__col-sorted-by--always")).toBe(false);

    // Modified has no column at all: the Name header always says so.
    await chooseSort("file-browser-sort-by-modified");
    const always = container.querySelector('[data-testid="file-browser-sorted-by"]');
    expect(always?.classList.contains("file-browser__col-sorted-by--always")).toBe(true);
  });

  it("shows no 'sorted by' hint while sorting by name", async () => {
    await renderLocalAt("/home");
    expect(container.querySelector('[data-testid="file-browser-sorted-by"]')).toBeNull();
  });
});
