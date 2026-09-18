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

describe("FileBrowser – row meta (name-first, hover overlay) (#2798 regression)", () => {
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

  it("renders a real byte size in the hover-meta overlay for a file", async () => {
    await renderLocalAt("/home");
    const size = rowWrapper("bigfile.bin")?.querySelector(
      ".file-browser__meta .file-browser__size"
    );
    expect(size?.textContent).toBe("1.5 KB");
    // The size lives in the meta overlay …
    expect(size?.closest(".file-browser__meta")).toBeTruthy();
  });

  it("renders the meta as a sibling overlay, not nested inside the row button", async () => {
    await renderLocalAt("/home");
    // The meta overlay is a sibling of the `.file-browser__row` button (so it can
    // be absolutely positioned and never reserve space in the name area) — it is
    // NOT a descendant of the button itself.
    expect(
      container.querySelector('[data-testid="file-row-bigfile.bin"] .file-browser__meta')
    ).toBe(null);
    expect(rowWrapper("bigfile.bin")?.querySelector(".file-browser__meta")).toBeTruthy();
  });

  it("keeps the whole row on a single line (no stacked name-line + meta-line)", async () => {
    await renderLocalAt("/home");
    // In the stacked (two-line) layout the meta lived inside the button body next
    // to the name-line. Now the button body contains only the name line.
    const body = rowWrapper("bigfile.bin")?.querySelector(".file-browser__body");
    expect(body?.querySelector(".file-browser__meta")).toBe(null);
    expect(body?.querySelector(".file-browser__name-line")).toBeTruthy();
  });

  it("does not render a size (no NaN) for a file with an unknown size", async () => {
    await renderLocalAt("/home");
    const wrapper = rowWrapper("unknown.dat");
    expect(wrapper).toBeTruthy();
    // No size cell is rendered when the size is unknown …
    expect(wrapper?.querySelector(".file-browser__size")).toBeNull();
    // … and nothing in the browser ever renders the "NaN" garbage (#2798).
    expect(container.textContent).not.toContain("NaN");
  });

  it("renders no size cell and no middot separators for a directory", async () => {
    await renderLocalAt("/home");
    const wrapper = rowWrapper("adir");
    expect(wrapper).toBeTruthy();
    // Directory: Modified + permissions in the overlay — no Size …
    expect(wrapper?.querySelector(".file-browser__size")).toBeNull();
    // … and the overlay uses adjacent columns, never middot separators.
    expect(container.querySelectorAll(".file-browser__meta-sep").length).toBe(0);
    const meta = wrapper?.querySelector(".file-browser__meta");
    expect((meta?.textContent ?? "").includes("·")).toBe(false);
  });

  it("renders permissions in the hover-meta overlay when present", async () => {
    await renderLocalAt("/home");
    const perms = rowWrapper("bigfile.bin")?.querySelector(".file-browser__permissions");
    expect(perms?.textContent).toBe("-rw-r--r--");
    expect(perms?.closest(".file-browser__meta")).toBeTruthy();
  });

  it("shows the filename in full and keeps it as the name tooltip", async () => {
    await renderLocalAt("/home");
    const name = container.querySelector(
      '[data-testid="file-row-bigfile.bin"] .file-browser__name'
    );
    // Full name rendered verbatim (never truncated/ellipsized) …
    expect(name?.textContent).toBe("bigfile.bin");
    // … and mirrored into the title attribute as the guaranteed readability path.
    expect(name?.getAttribute("title")).toBe("bigfile.bin");
    expect(name?.closest(".file-browser__name-line")).toBeTruthy();
  });

  it("sets an absolute timestamp as the Modified tooltip", async () => {
    await renderLocalAt("/home");
    const modified = rowWrapper("bigfile.bin")?.querySelector(".file-browser__modified");
    const title = modified?.getAttribute("title");
    expect(title).toBeTruthy();
    // The absolute timestamp is localized but always carries the full year.
    expect(title).toContain("2026");
  });
});

// The regression from #2798 was a CSS one (rows truncated the name and the list
// stopped scrolling), so pin the stylesheet's load-bearing rules directly.
describe("FileBrowser.css – name-first + scroll rules (#2798 regression)", () => {
  // Vitest runs from the repo root, so resolve the stylesheet against cwd.
  const css = readFileSync("src/components/Sidebar/FileBrowser.css", "utf8");

  /** Return the declaration body of `<selector> { ... }` (first match), or "". */
  function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    return match ? match[1] : "";
  }

  it("never truncates the filename (no ellipsis / overflow:hidden on the name)", () => {
    const name = ruleBody(".file-browser__name");
    expect(name).not.toContain("text-overflow: ellipsis");
    expect(name).not.toContain("overflow: hidden");
    expect(name).toContain("white-space: nowrap");
  });

  it("restores the scroll viewport (min-height:0 + overflow on the list)", () => {
    const list = ruleBody(".file-browser__list");
    expect(list).toContain("min-height: 0");
    expect(list).toContain("overflow-y: auto");
    // A too-long name is reachable via horizontal scroll instead of being cut.
    expect(list).toContain("overflow-x: auto");
  });

  it("hides the metadata at rest as an absolutely-positioned right overlay", () => {
    const meta = ruleBody(".file-browser__meta");
    expect(meta).toContain("position: absolute");
    expect(meta).toContain("opacity: 0");
    expect(meta).toContain("right: 0");
    // The row wrapper must establish the positioning context for that overlay.
    expect(ruleBody(".file-browser__row-wrapper")).toContain("position: relative");
  });

  it("drops the middot separator rule entirely", () => {
    expect(css).not.toContain(".file-browser__meta-sep");
  });
});
