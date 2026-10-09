/**
 * Accessibility semantics of the file browser list (#4349, audit A11Y2-007).
 *
 * The list must be a named list whose row buttons expose their selection
 * state (aria-pressed — a listbox would forbid the per-row actions button), whose accessible names carry the entry
 * type (file / folder / symbolic link), and whose sort headers expose the
 * active sort direction in a way assistive tech actually reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
import { checkA11y } from "@/test/axe";
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
  { name: "report.pdf", path: "/home/report.pdf", isDirectory: false, size: 10, modified: "" },
  { name: "mydir", path: "/home/mydir", isDirectory: true, size: 0, modified: "" },
  {
    name: "link",
    path: "/home/link",
    isDirectory: false,
    isSymlink: true,
    symlinkTarget: "/etc/hosts",
    size: 0,
    modified: "",
  },
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

async function renderLocal() {
  const tab = makeTab({});
  const panel: LeafPanel = { type: "leaf", id: tab.panelId, tabs: [tab], activeTabId: tab.id };
  seedLayoutState({ activePanelId: tab.panelId, rootPanel: panel });
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

function byTestId(id: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no element with data-testid=${id}`);
  return el as HTMLElement;
}

/** The accessible name as computed for these elements: aria-label wins over text. */
function accessibleName(el: HTMLElement): string {
  return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
}

setupFileBrowsersRegion();
setupVirtualListSizing();

describe("FileBrowser — list accessibility (#4349)", () => {
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

  it("renders the entries as a named list of items", async () => {
    await renderLocal();
    const list = byTestId("file-browser-list").querySelector('[role="list"]');
    expect(list?.getAttribute("aria-label")).toBe("Files in /home");
    expect(list?.querySelectorAll(':scope > [role="listitem"]')).toHaveLength(entries.length);
  });

  it("includes the entry type in each row's accessible name", async () => {
    await renderLocal();
    expect(accessibleName(byTestId("file-row-report.pdf"))).toBe("report.pdf, file");
    expect(accessibleName(byTestId("file-row-mydir"))).toBe("mydir, folder");
    expect(accessibleName(byTestId("file-row-link"))).toBe(
      "link, symbolic link, target /etc/hosts"
    );
  });

  it("exposes selection through aria-pressed", async () => {
    await renderLocal();
    const report = byTestId("file-row-report.pdf");
    const dir = byTestId("file-row-mydir");
    expect(report.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      report.click();
    });
    expect(byTestId("file-row-report.pdf").getAttribute("aria-pressed")).toBe("true");
    expect(dir.getAttribute("aria-pressed")).toBe("false");
  });

  it("exposes the sort state in the sort buttons' names, not via invalid aria-sort", async () => {
    await renderLocal();
    const nameSort = byTestId("file-browser-sort-name");
    const sizeSort = byTestId("file-browser-sort-size");
    // aria-sort is only valid on columnheader/rowheader — never on a button.
    expect(nameSort.hasAttribute("aria-sort")).toBe(false);
    expect(accessibleName(nameSort)).toBe("Name, sorted ascending");
    expect(accessibleName(sizeSort)).toBe("Sort by Size");
    await act(async () => {
      nameSort.click();
    });
    expect(accessibleName(byTestId("file-browser-sort-name"))).toBe("Name, sorted descending");
  });

  it("has no axe violations in the list", async () => {
    await renderLocal();
    expect(await checkA11y(byTestId("file-browser-list"))).toHaveNoViolations();
  });
});
