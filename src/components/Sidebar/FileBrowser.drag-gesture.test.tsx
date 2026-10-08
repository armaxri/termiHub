/**
 * Drag-to-move journeys (PROD-006) through the REAL FileBrowser, the REAL dnd-kit
 * PointerSensor and the REAL test-bridge `dragTo` verb — the jsdom twin of the
 * live bridge tests in `tests/system/tests/test_file_browser_local.py` (#4007).
 *
 * `FileBrowser.drag-move.test.tsx` drives the DndContext handlers directly; this
 * suite instead fires the bridge's pointer gesture, so it pins what the live
 * tests rely on: the row's own testid exposes the drop highlight mid-drag, the
 * floating chip says Move vs Copy, each breadcrumb segment has its own testid,
 * a held Alt reaches the provider through the pointer events, and a folder
 * dropped on itself is refused.
 *
 * jsdom has no layout, so `getBoundingClientRect` is stubbed per testid: the
 * breadcrumbs on one line at the top, the rows stacked below them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
import { seedLayoutState } from "@/test/layoutState";
import { dispatchCommand, type BridgeDeps } from "@/testbridge/dispatcher";
import type { DragModifiers, DragObservations } from "@/testbridge/protocol";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import { TooltipProvider } from "@/components/ui";
import { FileBrowser } from "./FileBrowser";

const toastError = vi.fn();

vi.mock("@/components/ui/Toast", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/ui/Toast")>("@/components/ui/Toast");
  return {
    ...actual,
    toast: {
      success: vi.fn(),
      error: (...args: unknown[]) => toastError(...args),
      info: vi.fn(),
      loading: vi.fn(() => "toast-id"),
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

const mockedInvoke = vi.mocked(invoke);

const homeEntries = [
  { name: "a.txt", path: "/home/a.txt", isDirectory: false, size: 1, modified: "" },
  { name: "docs", path: "/home/docs", isDirectory: true, size: 0, modified: "" },
];

/** Viewport rects per testid: crumbs on one line, rows stacked below. */
const LAYOUT: Record<string, [left: number, top: number, width: number, height: number]> = {
  "file-browser-crumb-/": [10, 10, 20, 20],
  "file-browser-crumb-home": [40, 10, 50, 20],
  "file-row-docs": [0, 100, 280, 28],
  "file-row-a.txt": [0, 128, 280, 28],
};

/**
 * The testid an element is laid out by: its own, or — for a row's wrapper (the
 * dnd-kit node) — that of the row button directly inside it.
 */
function layoutId(el: Element): string | null {
  const own = el.getAttribute("data-testid");
  if (own) return own;
  return el.querySelector(":scope > [data-testid]")?.getAttribute("data-testid") ?? null;
}

let container: HTMLDivElement;
let root: Root;

function makeTab(): TerminalTab {
  return {
    id: "tab-1",
    sessionId: "sess-1",
    title: "Test Tab",
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "panel-1",
    isActive: true,
  };
}

async function renderLocal() {
  const tab = makeTab();
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

/**
 * Run the bridge's `dragTo` OUTSIDE `act()` (which would hold dnd-kit's
 * drag-start render until the whole gesture is over), then let the drop's
 * transfer settle.
 */
async function dragTo(
  from: string,
  to: string,
  options: { modifiers?: DragModifiers; observe?: string[] } = {}
): Promise<DragObservations> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prev = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = false;
  let res;
  try {
    res = await dispatchCommand({ action: "dragTo", fromTestId: from, toTestId: to, ...options }, {
      root: document,
    } as unknown as BridgeDeps);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = prev;
  }
  expect(res.ok).toBe(true);
  await act(async () => {
    await flushAsync();
  });
  return (res.value ?? {}) as DragObservations;
}

function calls(cmd: string) {
  return mockedInvoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

const CHIP = "file-browser-drag-chip";

setupFileBrowsersRegion();
setupVirtualListSizing();

describe("FileBrowser — drag-to-move journeys via the bridge gesture (#4007)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    toastError.mockReset();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element
    ) {
      const id = layoutId(this);
      const rect = id ? LAYOUT[id] : undefined;
      return rect ? new DOMRect(...rect) : new DOMRect(0, 0, 0, 0);
    });
    mockedInvoke.mockImplementation((cmd: string, args?: InvokeArgs) => {
      if (cmd === "local_list_dir") {
        const path = (args as { path?: string } | undefined)?.path;
        return Promise.resolve(path === "/home" ? homeEntries : []);
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("highlights the hovered folder row and shows a Move chip, then moves on release", async () => {
    await renderLocal();

    const seen = await dragTo("file-row-a.txt", "file-row-docs", {
      observe: ["file-row-docs", CHIP],
    });

    expect(seen["file-row-docs"].attributes["data-drop-highlight"]).toBe("valid");
    expect(seen[CHIP].exists).toBe(true);
    expect(seen[CHIP].text).toBe('Move "a.txt"');
    expect(calls("local_rename")).toEqual([
      { oldPath: "/home/a.txt", newPath: "/home/docs/a.txt" },
    ]);
    // The chip and the highlight end with the gesture.
    expect(document.querySelector(`[data-testid="${CHIP}"]`)).toBeNull();
    expect(
      document.querySelector('[data-testid="file-row-docs"]')?.hasAttribute("data-drop-highlight")
    ).toBe(false);
  });

  it("moves a file up into an ancestor dropped on its breadcrumb segment", async () => {
    await renderLocal();

    const seen = await dragTo("file-row-a.txt", "file-browser-crumb-/", {
      observe: ["file-browser-crumb-/"],
    });

    expect(seen["file-browser-crumb-/"].attributes["data-drop-highlight"]).toBe("valid");
    expect(calls("local_rename")).toEqual([{ oldPath: "/home/a.txt", newPath: "/a.txt" }]);
  });

  it("marks a folder dropped on its own row as refused, and moves nothing", async () => {
    await renderLocal();

    const seen = await dragTo("file-row-docs", "file-row-docs", { observe: ["file-row-docs"] });

    expect(seen["file-row-docs"].attributes["data-drop-highlight"]).toBe("invalid");
    expect(toastError).toHaveBeenCalledWith('Cannot move "docs" into itself');
    expect(calls("local_rename")).toEqual([]);
    expect(calls("local_copy_start")).toEqual([]);
  });

  it("copies instead of moving when the drag holds Alt", async () => {
    await renderLocal();

    const seen = await dragTo("file-row-a.txt", "file-row-docs", {
      modifiers: { alt: true },
      observe: [CHIP],
    });

    expect(seen[CHIP].text).toBe('Copy "a.txt"');
    expect(calls("local_copy_start")).toEqual([
      { srcPath: "/home/a.txt", destPath: "/home/docs/a.txt" },
    ]);
    expect(calls("local_rename")).toEqual([]);
  });
});
