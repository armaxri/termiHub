/**
 * Accessibility semantics of the file browser list (#4349, audit A11Y2-007).
 *
 * The list must be a named, multi-selectable listbox whose rows are options
 * exposing their selection through aria-selected (#4559), whose accessible
 * names carry the entry type (file / folder / symbolic link), and whose sort
 * headers expose the active sort direction in a way assistive tech actually
 * reads. The per-row "File actions" button is mouse-only; the keyboard path to
 * a row's actions is Shift+F10 / the ContextMenu key on the focused row.
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

  it("renders the entries as a named, multi-selectable listbox of options", async () => {
    await renderLocal();
    const listbox = byTestId("file-browser-list").querySelector('[role="listbox"]');
    expect(listbox?.getAttribute("aria-label")).toBe("Files in /home");
    expect(listbox?.getAttribute("aria-multiselectable")).toBe("true");
    const options = listbox?.querySelectorAll('[role="option"]') ?? [];
    expect(options).toHaveLength(entries.length);
    expect(byTestId("file-row-report.pdf").getAttribute("role")).toBe("option");
    // The legacy list semantics are gone.
    expect(byTestId("file-browser-list").querySelector('[role="list"], [role="listitem"]')).toBe(
      null
    );
  });

  it("keeps the per-row actions button out of the Tab order and the a11y tree", async () => {
    await renderLocal();
    const menuButton = byTestId("file-row-menu-report.pdf");
    expect(menuButton.getAttribute("tabindex")).toBe("-1");
    expect(menuButton.getAttribute("aria-hidden")).toBe("true");
    // Exactly one row is a Tab stop (roving tabindex).
    const tabStops = byTestId("file-browser-list").querySelectorAll('[tabindex="0"]');
    expect(tabStops).toHaveLength(1);
  });

  it("includes the entry type in each row's accessible name", async () => {
    await renderLocal();
    expect(accessibleName(byTestId("file-row-report.pdf"))).toBe("report.pdf, file");
    expect(accessibleName(byTestId("file-row-mydir"))).toBe("mydir, folder");
    expect(accessibleName(byTestId("file-row-link"))).toBe(
      "link, symbolic link, target /etc/hosts"
    );
  });

  it("exposes selection through aria-selected, not aria-pressed", async () => {
    await renderLocal();
    const report = byTestId("file-row-report.pdf");
    expect(report.getAttribute("aria-selected")).toBe("false");
    expect(report.hasAttribute("aria-pressed")).toBe(false);
    await act(async () => {
      report.click();
    });
    expect(byTestId("file-row-report.pdf").getAttribute("aria-selected")).toBe("true");
    expect(byTestId("file-row-mydir").getAttribute("aria-selected")).toBe("false");
  });

  it("reflects a multi-selection on every selected option", async () => {
    await renderLocal();
    await act(async () => {
      byTestId("file-row-report.pdf").click();
    });
    await act(async () => {
      byTestId("file-row-link").dispatchEvent(
        new MouseEvent("click", { ctrlKey: true, bubbles: true })
      );
    });
    expect(byTestId("file-row-report.pdf").getAttribute("aria-selected")).toBe("true");
    expect(byTestId("file-row-link").getAttribute("aria-selected")).toBe("true");
    expect(byTestId("file-row-mydir").getAttribute("aria-selected")).toBe("false");
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

  it("has no axe violations with a multi-selection (aria-required-children)", async () => {
    await renderLocal();
    await act(async () => {
      byTestId("file-row-report.pdf").click();
    });
    await act(async () => {
      byTestId("file-row-mydir").dispatchEvent(
        new MouseEvent("click", { ctrlKey: true, bubbles: true })
      );
    });
    expect(await checkA11y(byTestId("file-browser-list"))).toHaveNoViolations();
  });
});

/** Fire a keydown on `el` and return the event (to inspect defaultPrevented). */
function keyDown(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
}

function inBody(id: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
}

describe("FileBrowser — keyboard row-actions shortcut (#4559)", () => {
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

  it("opens the focused row's actions menu on Shift+F10", async () => {
    await renderLocal();
    const row = byTestId("file-row-report.pdf");
    row.focus();
    expect(inBody("context-file-rename")).toBe(null);
    const ev = keyDown(row, { key: "F10", shiftKey: true });
    await flushAsync();
    expect(ev.defaultPrevented).toBe(true);
    expect(inBody("context-file-rename")).not.toBe(null);
  });

  it("opens the focused row's actions menu on the ContextMenu key", async () => {
    await renderLocal();
    const row = byTestId("file-row-mydir");
    row.focus();
    keyDown(row, { key: "ContextMenu" });
    await flushAsync();
    expect(inBody("context-file-rename")).not.toBe(null);
  });

  it("opens the multi-selection menu when the focused row is part of a selection", async () => {
    await renderLocal();
    await act(async () => {
      byTestId("file-row-report.pdf").click();
    });
    await act(async () => {
      byTestId("file-row-link").dispatchEvent(
        new MouseEvent("click", { ctrlKey: true, bubbles: true })
      );
    });
    keyDown(byTestId("file-row-link"), { key: "F10", shiftKey: true });
    await flushAsync();
    expect(inBody("multi-select-delete")).not.toBe(null);
  });

  it("ignores plain F10 and modified Shift+F10", async () => {
    await renderLocal();
    const row = byTestId("file-row-report.pdf");
    const plain = keyDown(row, { key: "F10" });
    const ctrl = keyDown(row, { key: "F10", shiftKey: true, ctrlKey: true });
    await flushAsync();
    expect(plain.defaultPrevented).toBe(false);
    expect(ctrl.defaultPrevented).toBe(false);
    expect(inBody("context-file-rename")).toBe(null);
  });
});
