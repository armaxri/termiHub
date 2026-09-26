/**
 * Drag-to-move and the keyboard "Move to… / Copy to…" path in the file browser
 * (audit PROD-006).
 *
 * The drag gesture itself is pointer-driven dnd-kit, which jsdom cannot hit-test
 * (every rect is zero-sized), so these tests record what each row registers with
 * dnd-kit (drag payload / drop target) and drive the DndContext's own
 * `onDragStart` / `onDragEnd` with exactly those payloads — covering the real
 * row wiring, the multi-select payload, the Alt/Option copy modifier, the
 * guards, and the backend calls a drop produces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import type { ComponentProps } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type * as DndCore from "@dnd-kit/core";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import { seedLayoutState } from "@/test/layoutState";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/components/ui/Toast", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/ui/Toast")>("@/components/ui/Toast");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      info: vi.fn(),
      loading: vi.fn(() => "toast-id"),
      dismiss: vi.fn(),
    },
  };
});

// Record the dnd-kit registrations and the DndContext handlers.
const dragData = new Map<string, unknown>();
const dropData = new Map<string, unknown>();
let dndProps: ComponentProps<typeof DndCore.DndContext> | null = null;

vi.mock("@dnd-kit/core", async () => {
  const actual = await vi.importActual<typeof DndCore>("@dnd-kit/core");
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      dndProps = props;
      return <actual.DndContext {...props} />;
    },
    useDraggable: (args: Parameters<typeof actual.useDraggable>[0]) => {
      dragData.set(String(args.id), args.data);
      return actual.useDraggable(args);
    },
    useDroppable: (args: Parameters<typeof actual.useDroppable>[0]) => {
      if (!args.disabled) dropData.set(String(args.id), args.data);
      return actual.useDroppable(args);
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

let container: HTMLDivElement;
let root: Root;

const homeEntries = [
  { name: "a.txt", path: "/home/a.txt", isDirectory: false, size: 1, modified: "" },
  { name: "b.txt", path: "/home/b.txt", isDirectory: false, size: 1, modified: "" },
  { name: "docs", path: "/home/docs", isDirectory: true, size: 0, modified: "" },
  {
    name: "locked",
    path: "/home/locked",
    isDirectory: true,
    size: 0,
    modified: "",
    writable: false,
  },
];

/** Listing for `/home/docs`; tests override it to create name conflicts. */
let docsEntries: Array<Record<string, unknown>> = [];

function argPath(args?: InvokeArgs): string | undefined {
  return (args as { path?: string } | undefined)?.path;
}

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

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const row = (name: string) => q(`file-row-${name}`);

/** Drive a drop of the row `source`'s drag payload onto drop target `targetId`. */
async function drop(source: string, targetId: string, altKey = false) {
  const active = { id: `file:${source}`, data: { current: dragData.get(`file:${source}`) } };
  const over = { id: targetId, data: { current: dropData.get(targetId) } };
  expect(active.data.current).toBeTruthy();
  expect(over.data.current).toBeTruthy();
  await act(async () => {
    dndProps?.onDragStart?.({
      active,
      activatorEvent: new PointerEvent("pointerdown", { altKey }),
    } as unknown as DndCore.DragStartEvent);
  });
  await act(async () => {
    dndProps?.onDragEnd?.({ active, over } as unknown as DndCore.DragEndEvent);
  });
  await flushAsync();
}

function calls(cmd: string) {
  return mockedInvoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

setupFileBrowsersRegion();
setupVirtualListSizing();

describe("FileBrowser — drag-to-move (PROD-006)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    dragData.clear();
    dropData.clear();
    dndProps = null;
    docsEntries = [];
    mockedInvoke.mockImplementation((cmd: string, args?: InvokeArgs) => {
      if (cmd === "local_list_dir") {
        const path = argPath(args);
        return Promise.resolve(
          path === "/home" ? homeEntries : path === "/home/docs" ? docsEntries : []
        );
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("registers every row as a drag source and only folders + breadcrumbs as drop targets", async () => {
    await renderLocal();
    expect(dragData.has("file:/home/a.txt")).toBe(true);
    expect(dragData.has("file:/home/docs")).toBe(true);
    expect(dropData.has("dir:/home/docs")).toBe(true);
    expect(dropData.has("dir:/home/a.txt")).toBe(false);
    expect(dropData.has("crumb:/")).toBe(true);
  });

  it("moves a file dropped on a folder with a single rename (no copy)", async () => {
    await renderLocal();
    await drop("/home/a.txt", "dir:/home/docs");
    expect(calls("local_rename")).toEqual([
      { oldPath: "/home/a.txt", newPath: "/home/docs/a.txt" },
    ]);
    expect(calls("local_copy")).toEqual([]);
    expect(toastSuccess).toHaveBeenCalledWith(
      'Moved "a.txt" to /home/docs',
      expect.objectContaining({ id: "toast-id" })
    );
  });

  it("copies instead when Alt/Option is held", async () => {
    await renderLocal();
    await drop("/home/a.txt", "dir:/home/docs", true);
    expect(calls("local_copy")).toEqual([
      { srcPath: "/home/a.txt", destPath: "/home/docs/a.txt", isDirectory: false },
    ]);
    expect(calls("local_rename")).toEqual([]);
  });

  it("drags the whole multi-selection when a selected row is dragged", async () => {
    await renderLocal();
    await act(async () => {
      row("a.txt").click();
    });
    await act(async () => {
      row("b.txt").dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });
    await drop("/home/b.txt", "crumb:/");
    expect(calls("local_rename")).toEqual([
      { oldPath: "/home/a.txt", newPath: "/a.txt" },
      { oldPath: "/home/b.txt", newPath: "/b.txt" },
    ]);
  });

  it("refuses dropping a folder into itself", async () => {
    await renderLocal();
    await drop("/home/docs", "dir:/home/docs");
    expect(toastError).toHaveBeenCalledWith('Cannot move "docs" into itself');
    expect(calls("local_rename")).toEqual([]);
  });

  it("refuses dropping into a read-only folder", async () => {
    await renderLocal();
    await drop("/home/a.txt", "dir:/home/locked");
    expect(toastError).toHaveBeenCalledWith('"locked" is read-only');
    expect(calls("local_rename")).toEqual([]);
  });

  it("asks before replacing an existing name, and only moves on confirm", async () => {
    docsEntries = [
      { name: "a.txt", path: "/home/docs/a.txt", isDirectory: false, size: 1, modified: "" },
    ];
    await renderLocal();
    await drop("/home/a.txt", "dir:/home/docs");
    expect(q("file-move-conflict-dialog")).toBeTruthy();
    expect(q("file-move-conflict-dialog").textContent).toContain('"a.txt" already exists');
    expect(calls("local_rename")).toEqual([]);
    await act(async () => {
      q("file-move-conflict-confirm").click();
    });
    await flushAsync();
    expect(calls("local_rename")).toEqual([
      { oldPath: "/home/a.txt", newPath: "/home/docs/a.txt" },
    ]);
  });

  it("offers Move to… from the keyboard-reachable context menu", async () => {
    await renderLocal();
    await act(async () => {
      row("a.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await act(async () => {
      q("context-file-move-to").click();
    });
    const input = q("move-to-destination") as HTMLInputElement;
    expect(input.value).toBe("/home");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "/home/docs");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAsync();
    expect(calls("local_rename")).toEqual([
      { oldPath: "/home/a.txt", newPath: "/home/docs/a.txt" },
    ]);
  });

  it("offers Copy to… for a multi-selection", async () => {
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
      q("multi-select-copy-to").click();
    });
    const input = q("move-to-destination") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "/home/docs");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      q("move-to-submit").click();
    });
    await flushAsync();
    expect(calls("local_copy")).toHaveLength(2);
    expect(calls("local_rename")).toEqual([]);
  });
});
