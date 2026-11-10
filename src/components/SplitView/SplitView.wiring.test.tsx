/**
 * SplitView component wiring (#5171, COV-012).
 *
 * The pure drop routing is covered by `resolveTabDrop.test.ts`; this file covers
 * the component around it:
 *
 * - `handleDragStart` / `handleDragEnd` / `handleDragCancel`: how a dnd-kit event
 *   is read (the release point, the pointer-hit fallback through
 *   `document.elementsFromPoint` when dnd-kit reports `over == null`, tear-off)
 *   and which store action the drop dispatches;
 * - the split's `onLayoutChanged` guard (non-finite / negative sizes are
 *   rejected, an unchanged layout is skipped, a real change is persisted);
 * - the zoomed tab's title menu (rename / save / copy / clear / horizontal
 *   scrolling / set colour) and the rename and colour dialog round-trips, plus
 *   the same dialogs reached from an in-panel terminal's context menu;
 * - the per-content-type render branches of the panel, the zoom overlay and the
 *   drag overlay.
 *
 * dnd-kit's pointer sensor needs real layout to activate, which jsdom does not
 * have, so the real `DndContext` is wrapped to capture the handlers SplitView
 * passes it; the tests then call them with dnd-kit-shaped events. Likewise the
 * real `Group` is wrapped to capture `onLayoutChanged`. Everything else — the
 * store, TabBar, the drop zones, the dialogs, the menus — is real.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { withTooltip } from "@/test/tooltip";
import type { LeafPanel, PanelNode, SplitContainer, TerminalTab } from "@/types/terminal";

// --- Captured third-party handlers --------------------------------------------

interface DndHandlers {
  onDragStart?: (e: DragStartEvent) => void;
  onDragEnd?: (e: DragEndEvent) => void;
  onDragCancel?: () => void;
}
/** The handlers of the active group's DndContext (inactive groups pass none). */
let dnd: DndHandlers = {};
/** The `onLayoutChanged` of the most recently rendered split Group. */
let onLayoutChanged: ((layout: Record<string, number>) => void) | undefined;

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
      if (props.onDragEnd) {
        dnd = {
          onDragStart: props.onDragStart as DndHandlers["onDragStart"],
          onDragEnd: props.onDragEnd as DndHandlers["onDragEnd"],
          onDragCancel: props.onDragCancel as DndHandlers["onDragCancel"],
        };
      }
      return <actual.DndContext {...props} />;
    },
    // dnd-kit only renders the overlay while its own sensor has an active drag,
    // which the captured handlers bypass; render its children directly.
    DragOverlay: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock("react-resizable-panels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-resizable-panels")>();
  return {
    ...actual,
    Group: (props: React.ComponentProps<typeof actual.Group>) => {
      onLayoutChanged = props.onLayoutChanged as typeof onLayoutChanged;
      return <actual.Group {...props} />;
    },
  };
});

// --- Terminal registry ---------------------------------------------------------

const registry = {
  getElement: vi.fn((_tabId: string): HTMLElement | null => null),
  focusTerminal: vi.fn(),
  fitTerminal: vi.fn(),
  clearTerminal: vi.fn(),
  saveTerminalToFile: vi.fn(),
  copyTerminalToClipboard: vi.fn(),
  openTerminalInEditor: vi.fn(),
  getTerminalSelection: vi.fn((_tabId: string): string | undefined => undefined),
  clearTerminalSelection: vi.fn(),
  copySelectionToClipboard: vi.fn(() => Promise.resolve()),
  pasteToTerminal: vi.fn(() => Promise.resolve()),
  isMouseReportingActive: vi.fn((_tabId: string) => false),
  findNext: vi.fn(() => false),
  findPrevious: vi.fn(() => false),
  clearSearchDecorations: vi.fn(),
  onSearchResults: vi.fn(() => () => {}),
  parkingRef: { current: document.createElement("div") },
};
vi.mock("@/components/Terminal/TerminalRegistry", () => ({
  useTerminalRegistry: () => registry,
}));

// --- Lazy surfaces: light stubs so each content-type branch renders a marker ---

function stub(name: string) {
  return (props: { tabId?: string; isVisible?: boolean }) => (
    <div data-testid={`stub-${name}`} data-visible={String(props.isVisible)} />
  );
}
vi.mock("@/components/FileEditor", () => ({ FileEditor: stub("editor") }));
vi.mock("@/components/Settings/SettingsPanel", () => ({ SettingsPanel: stub("settings") }));
vi.mock("@/components/ConnectionEditor/ConnectionEditor", () => ({
  ConnectionEditor: stub("connection-editor"),
}));
vi.mock("@/components/LogViewer/LogViewer", () => ({ LogViewer: stub("log-viewer") }));
vi.mock("@/components/TunnelEditor/TunnelEditor", () => ({ TunnelEditor: stub("tunnel-editor") }));
vi.mock("@/components/WorkspaceEditor/WorkspaceEditor", () => ({
  WorkspaceEditor: stub("workspace-editor"),
}));
vi.mock("@/components/NetworkTools/NetworkDiagnosticPanel", () => ({
  NetworkDiagnosticPanel: stub("network-diagnostic"),
}));
vi.mock("@/components/TransferView", () => ({ TransferView: stub("transfer-view") }));
vi.mock("@/components/Plugins/PluginDetailPanel", () => ({
  PluginDetailPanel: stub("plugin-detail"),
}));
vi.mock("@/components/RemoteDesktop/RemoteDesktopTab", () => ({
  RemoteDesktopTab: stub("remote-desktop"),
}));
vi.mock("@/components/Terminal/FileBrowserTab", () => ({ FileBrowserTab: stub("file-browser") }));
vi.mock("@/components/Terminal/AgentErrorTab", () => ({ AgentErrorTab: stub("agent-error") }));

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  listSessionOwners: vi.fn(() => Promise.resolve({})),
}));

// Imported after the mocks so SplitView picks them up.
const { SplitView } = await import("./SplitView");

// --- Fixtures --------------------------------------------------------------------

type ContentType = TerminalTab["contentType"];

/** Per-content-type meta, so each "type && meta" render branch is taken. */
function metaFor(contentType: ContentType): Partial<TerminalTab> {
  switch (contentType) {
    case "editor":
      return {
        editorMeta: { filePath: "/tmp/a.txt", isRemote: false } as TerminalTab["editorMeta"],
      };
    case "connection-editor":
      return {
        connectionEditorMeta: { connectionId: "c1" } as TerminalTab["connectionEditorMeta"],
      };
    case "tunnel-editor":
      return { tunnelEditorMeta: { tunnelId: "t1" } as TerminalTab["tunnelEditorMeta"] };
    case "workspace-editor":
      return {
        workspaceEditorMeta: { workspaceId: "w1" } as TerminalTab["workspaceEditorMeta"],
      };
    case "network-diagnostic":
      return {
        networkDiagnosticMeta: { tool: "ping" } as unknown as TerminalTab["networkDiagnosticMeta"],
      };
    case "transfer-view":
      return { transferViewMeta: {} as TerminalTab["transferViewMeta"] };
    case "plugin-detail":
      return { pluginDetailMeta: { pluginId: "p1" } as TerminalTab["pluginDetailMeta"] };
    case "agent-error":
      return { agentErrorMeta: { agentId: "a1" } as unknown as TerminalTab["agentErrorMeta"] };
    default:
      return {};
  }
}

function tab(id: string, panelId: string, contentType: ContentType = "terminal"): TerminalTab {
  return {
    id,
    sessionId: null,
    title: `Title ${id}`,
    connectionType: "local",
    contentType,
    config: { type: "local", config: { shell: "zsh" } },
    panelId,
    isActive: true,
    ...metaFor(contentType),
  };
}

function leaf(id: string, tabs: TerminalTab[], activeTabId = tabs[0]?.id ?? null): LeafPanel {
  return { type: "leaf", id, tabs, activeTabId };
}

/** Two panels side by side: `left` holds two terminals, `right` one. */
function twoPanelSplit(sizes?: number[]): SplitContainer {
  return {
    type: "split",
    id: "split-root",
    direction: "horizontal",
    children: [
      leaf("left", [tab("t1", "left"), tab("t2", "left")]),
      leaf("right", [tab("t3", "right")]),
    ],
    ...(sizes ? { sizes } : {}),
  };
}

function seed(rootPanel: PanelNode, activePanelId = "left"): void {
  seedLayoutState({ rootPanel, activePanelId });
}

/** Store actions SplitView dispatches to, replaced with spies. */
const ops = {
  moveTabToGroup: vi.fn(),
  addTabGroupWithTab: vi.fn(),
  splitPanelWithTab: vi.fn(),
  moveTab: vi.fn(),
  reorderTabs: vi.fn(),
  moveTabToWindow: vi.fn(() => Promise.resolve()),
  setDraggingTabId: vi.fn(),
  setPanelSizes: vi.fn(),
  renameTab: vi.fn(),
  setTabColor: vi.fn(),
  setTabHorizontalScrolling: vi.fn(),
};

// jsdom 28 has no `document.elementsFromPoint`; install a controllable one.
const elementsFromPoint = vi.fn((_x: number, _y: number): Element[] => []);

// --- Harness ---------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(withTooltip(<SplitView />));
  });
  await settle();
}

function q(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function pointerAt(x: number, y: number): Event {
  return new PointerEvent("pointerdown", { clientX: x, clientY: y });
}

function dragEnd(opts: {
  tabId?: string;
  fromPanelId?: string | null;
  over?: { id: string; data?: Record<string, unknown> } | null;
  activator?: Event;
  delta?: { x: number; y: number };
}): DragEndEvent {
  const fromPanelId = opts.fromPanelId === undefined ? "left" : opts.fromPanelId;
  return {
    active: {
      id: opts.tabId ?? "t1",
      data: { current: fromPanelId === null ? undefined : { panelId: fromPanelId } },
      rect: { current: { initial: null, translated: null } },
    },
    over: opts.over
      ? {
          id: opts.over.id,
          data: { current: opts.over.data },
          rect: { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 },
          disabled: false,
        }
      : null,
    activatorEvent: opts.activator ?? pointerAt(100, 100),
    delta: opts.delta ?? { x: 0, y: 0 },
    collisions: null,
  } as unknown as DragEndEvent;
}

function fireDragEnd(event: DragEndEvent): void {
  act(() => dnd.onDragEnd!(event));
}

function contextMenuOn(el: Element): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
    );
  });
}

async function clickItem(testId: string): Promise<void> {
  const el = q(testId);
  expect(el, `${testId} should be rendered`).not.toBeNull();
  act(() => el!.click());
  await settle();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  dnd = {};
  onLayoutChanged = undefined;
  Object.values(ops).forEach((fn) => fn.mockClear());
  Object.values(registry).forEach((fn) => {
    if (typeof fn === "function") (fn as ReturnType<typeof vi.fn>).mockClear();
  });
  elementsFromPoint.mockReset();
  elementsFromPoint.mockReturnValue([]);
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: elementsFromPoint,
  });
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    loadFromBackend: async () => {},
    ...ops,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

// --- Drag and drop -----------------------------------------------------------------

describe("SplitView drag end (#5171)", () => {
  beforeEach(async () => {
    seed(twoPanelSplit());
    await render();
    expect(dnd.onDragEnd).toBeTypeOf("function");
  });

  it("a drop on an edge zone dispatches the split resolveTabDrop chose", () => {
    fireDragEnd(dragEnd({ over: { id: "edge-right-left" } }));
    expect(ops.splitPanelWithTab).toHaveBeenCalledWith("t1", "left", "right", "left");
    // The drag state is cleared on every drop.
    expect(ops.setDraggingTabId).toHaveBeenCalledWith(null);
  });

  it("a drop on another panel's centre zone moves the tab there", () => {
    fireDragEnd(dragEnd({ over: { id: "center-right" } }));
    expect(ops.splitPanelWithTab).toHaveBeenCalledWith("t1", "left", "right", "center");
  });

  it("a drop on a tab in another panel moves the tab to that index", () => {
    fireDragEnd(dragEnd({ over: { id: "t3", data: { panelId: "right" } } }));
    expect(ops.moveTab).toHaveBeenCalledWith("t1", "left", "right", 0);
  });

  it("a drop on a sibling tab reorders within the panel", () => {
    fireDragEnd(dragEnd({ over: { id: "t2", data: { panelId: "left" } } }));
    expect(ops.reorderTabs).toHaveBeenCalledWith("left", 0, 1);
  });

  it("over == null inside the viewport looks through elementsFromPoint at the release point", () => {
    const chip = document.createElement("div");
    chip.setAttribute("data-tab-group-id", "group-b");
    const inner = document.createElement("span");
    chip.appendChild(inner);
    document.body.appendChild(chip);
    elementsFromPoint.mockReturnValue([inner]);

    fireDragEnd(dragEnd({ over: null, activator: pointerAt(100, 100), delta: { x: 20, y: -30 } }));

    // Release point = activator position + drag delta.
    expect(elementsFromPoint).toHaveBeenCalledWith(120, 70);
    expect(ops.moveTabToGroup).toHaveBeenCalledWith("t1", "left", "group-b");
  });

  it("over == null on the new-group button creates a group with the tab", () => {
    const btn = document.createElement("button");
    btn.setAttribute("data-new-group-btn", "");
    document.body.appendChild(btn);
    elementsFromPoint.mockReturnValue([btn]);

    fireDragEnd(dragEnd({ over: null }));
    expect(ops.addTabGroupWithTab).toHaveBeenCalledWith("t1", "left");
  });

  it("over == null on nothing in particular is a no-op", () => {
    fireDragEnd(dragEnd({ over: null }));
    expect(elementsFromPoint).toHaveBeenCalledTimes(1);
    for (const fn of [ops.moveTabToGroup, ops.addTabGroupWithTab, ops.moveTabToWindow]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("a release outside the viewport tears the tab off without probing the DOM", () => {
    fireDragEnd(dragEnd({ over: null, activator: pointerAt(10, 10), delta: { x: -500, y: 0 } }));
    expect(elementsFromPoint).not.toHaveBeenCalled();
    expect(ops.moveTabToWindow).toHaveBeenCalledWith("t1", "left", { kind: "new" });
  });

  it("tears off even when dnd-kit still reports a droppable near the window edge", () => {
    fireDragEnd(
      dragEnd({
        over: { id: "edge-right-right" },
        activator: pointerAt(window.innerWidth - 2, 10),
        delta: { x: 50, y: 0 },
      })
    );
    expect(ops.moveTabToWindow).toHaveBeenCalledWith("t1", "left", { kind: "new" });
    expect(ops.splitPanelWithTab).not.toHaveBeenCalled();
  });

  it("a non-pointer activator has no release point: no DOM probe, no tear-off", () => {
    fireDragEnd(
      dragEnd({ over: null, activator: new KeyboardEvent("keydown"), delta: { x: -5000, y: 0 } })
    );
    expect(elementsFromPoint).not.toHaveBeenCalled();
    expect(ops.moveTabToWindow).not.toHaveBeenCalled();
  });

  it("a drag that carried no panel id dispatches nothing", () => {
    fireDragEnd(dragEnd({ fromPanelId: null, over: { id: "edge-right-left" } }));
    expect(ops.splitPanelWithTab).not.toHaveBeenCalled();
    expect(ops.setDraggingTabId).toHaveBeenCalledWith(null);
  });
});

describe("SplitView drag start / cancel (#5171)", () => {
  function dragStart(tabId: string): DragStartEvent {
    return {
      active: { id: tabId, data: { current: { panelId: "left" } }, rect: { current: {} } },
      activatorEvent: pointerAt(0, 0),
    } as unknown as DragStartEvent;
  }

  it("starting a drag marks the tab dragging, shows the overlay and the drop zones", async () => {
    seed(twoPanelSplit());
    await render();
    act(() => dnd.onDragStart!(dragStart("t1")));
    await settle();

    expect(ops.setDraggingTabId).toHaveBeenCalledWith("t1");
    expect(document.querySelector(".tab--drag-overlay")?.textContent).toContain("Title t1");
    // Both panels show their drop zones while a tab is dragged.
    expect(document.querySelectorAll(".panel-drop-zone").length).toBeGreaterThan(0);

    act(() => dnd.onDragCancel!());
    await settle();
    expect(ops.setDraggingTabId).toHaveBeenLastCalledWith(null);
    expect(document.querySelector(".tab--drag-overlay")).toBeNull();
  });

  it("an unknown tab id starts nothing", async () => {
    seed(twoPanelSplit());
    await render();
    act(() => dnd.onDragStart!(dragStart("no-such-tab")));
    expect(ops.setDraggingTabId).not.toHaveBeenCalled();
  });

  it.each([
    "settings",
    "log-viewer",
    "editor",
    "connection-editor",
    "tunnel-editor",
    "workspace-editor",
    "network-diagnostic",
    "transfer-view",
    "file-browser",
  ] as const)("the drag overlay renders a %s tab's title", async (contentType) => {
    seed(leaf("left", [tab("x1", "left", contentType)]));
    await render();
    act(() => dnd.onDragStart!(dragStart("x1")));
    await settle();
    const overlay = document.querySelector(".tab--drag-overlay");
    expect(overlay?.textContent).toContain("Title x1");
    expect(overlay?.querySelector(".tab__icon")).not.toBeNull();
  });
});

// --- onLayoutChanged guard ------------------------------------------------------------

describe("SplitView split layout guard (#5171)", () => {
  beforeEach(async () => {
    seed(twoPanelSplit([50, 50]));
    await render();
    expect(onLayoutChanged).toBeTypeOf("function");
    ops.setPanelSizes.mockClear();
  });

  it("persists a real resize", () => {
    act(() => onLayoutChanged!({ left: 30, right: 70 }));
    expect(ops.setPanelSizes).toHaveBeenCalledWith("split-root", [30, 70]);
  });

  it("skips a layout equal to the stored one (within half a percent)", () => {
    act(() => onLayoutChanged!({ left: 50.2, right: 49.8 }));
    expect(ops.setPanelSizes).not.toHaveBeenCalled();
  });

  it.each([
    ["NaN", { left: Number.NaN, right: 50 }],
    ["Infinity", { left: Number.POSITIVE_INFINITY, right: 50 }],
    ["a missing child", { left: 50 }],
    ["a negative size", { left: -20, right: 120 }],
  ])("rejects %s", (_label, layout) => {
    act(() => onLayoutChanged!(layout as Record<string, number>));
    expect(ops.setPanelSizes).not.toHaveBeenCalled();
  });

  it("compares against an equal split when no sizes are stored", async () => {
    act(() => root.unmount());
    root = createRoot(container);
    seed(twoPanelSplit());
    await render();
    ops.setPanelSizes.mockClear();
    act(() => onLayoutChanged!({ left: 50, right: 50 }));
    expect(ops.setPanelSizes).not.toHaveBeenCalled();
    act(() => onLayoutChanged!({ left: 80, right: 20 }));
    expect(ops.setPanelSizes).toHaveBeenCalledWith("split-root", [80, 20]);
  });
});

// --- Zoom overlay ---------------------------------------------------------------------

describe("SplitView zoomed tab menu and dialogs (#5171)", () => {
  async function zoom(tabId: string, rootPanel: PanelNode = twoPanelSplit()): Promise<void> {
    seed(rootPanel);
    useAppStore.setState({ zoomedTabId: tabId });
    await render();
    expect(q("zoom-overlay")).not.toBeNull();
  }

  async function openTitleMenu(): Promise<void> {
    contextMenuOn(document.querySelector(".zoom-overlay__label")!);
    await settle();
  }

  it("save / copy / clear act on the zoomed terminal", async () => {
    await zoom("t1");
    await openTitleMenu();
    await clickItem("zoom-context-save");
    expect(registry.saveTerminalToFile).toHaveBeenCalledWith("t1");

    await openTitleMenu();
    await clickItem("zoom-context-copy");
    expect(registry.copyTerminalToClipboard).toHaveBeenCalledWith("t1");

    await openTitleMenu();
    await clickItem("zoom-context-clear");
    expect(registry.clearTerminal).toHaveBeenCalledWith("t1");
  });

  it("toggles horizontal scrolling from the stored value", async () => {
    await zoom("t1");
    await openTitleMenu();
    await clickItem("zoom-context-horizontal-scroll");
    expect(ops.setTabHorizontalScrolling).toHaveBeenCalledWith("t1", true);

    act(() => useAppStore.setState({ tabHorizontalScrolling: { t1: true } }));
    await openTitleMenu();
    await clickItem("zoom-context-horizontal-scroll");
    expect(ops.setTabHorizontalScrolling).toHaveBeenLastCalledWith("t1", false);
  });

  it("rename round-trips through the dialog", async () => {
    await zoom("t1");
    await openTitleMenu();
    await clickItem("zoom-context-rename");

    const input = q("rename-dialog-input") as HTMLInputElement;
    expect(input.value).toBe("Title t1");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "  build box  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickItem("rename-dialog-apply");

    expect(ops.renameTab).toHaveBeenCalledWith("t1", "build box");
    expect(q("rename-dialog-input")).toBeNull();
  });

  it("rename cancel closes without renaming", async () => {
    await zoom("t1");
    await openTitleMenu();
    await clickItem("zoom-context-rename");
    await clickItem("rename-dialog-cancel");
    expect(ops.renameTab).not.toHaveBeenCalled();
    expect(q("rename-dialog-input")).toBeNull();
  });

  it("set colour applies the picked swatch, and clear removes it", async () => {
    await zoom("t1");
    await openTitleMenu();
    await clickItem("zoom-context-set-color");

    const swatch = document.querySelector<HTMLElement>('[data-testid^="color-picker-swatch-"]');
    expect(swatch).not.toBeNull();
    const hex = `#${swatch!.getAttribute("data-testid")!.replace("color-picker-swatch-", "")}`;
    act(() => swatch!.click());
    await clickItem("color-picker-apply");
    expect(ops.setTabColor).toHaveBeenCalledWith("t1", hex);
    expect(q("color-picker-apply")).toBeNull();

    await openTitleMenu();
    await clickItem("zoom-context-set-color");
    await clickItem("color-picker-clear");
    expect(ops.setTabColor).toHaveBeenLastCalledWith("t1", null);
  });

  it("a non-terminal zoomed tab offers only Set Color", async () => {
    await zoom("s1", leaf("left", [tab("s1", "left", "settings")]));
    await openTitleMenu();
    expect(q("zoom-context-set-color")).not.toBeNull();
    expect(q("zoom-context-rename")).toBeNull();
    expect(q("zoom-context-clear")).toBeNull();
  });

  it("the zoomed terminal's right-click menu opens the same rename dialog", async () => {
    await zoom("t1");
    const trigger = q("zoom-terminal-context-trigger-t1");
    expect(trigger).not.toBeNull();
    contextMenuOn(trigger!);
    await settle();
    const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      /Rename/.test(el.textContent ?? "")
    );
    expect(rename).toBeDefined();
    act(() => rename!.click());
    await settle();
    expect((q("rename-dialog-input") as HTMLInputElement).value).toBe("Title t1");
  });

  it("closing the overlay clears the zoom", async () => {
    await zoom("t1");
    const close = document.querySelector<HTMLElement>(
      '[data-testid="zoom-overlay"] button[aria-label="Close"]'
    );
    expect(close).not.toBeNull();
    act(() => close!.click());
    await settle();
    expect(useAppStore.getState().zoomedTabId).toBeNull();
  });

  it("a zoomed tab that is not in the tree renders no overlay", async () => {
    seed(twoPanelSplit());
    useAppStore.setState({ zoomedTabId: "gone" });
    await render();
    expect(q("zoom-overlay")).toBeNull();
  });

  it("a connecting zoomed terminal shows the connection overlay instead of the slot", async () => {
    seed(twoPanelSplit());
    useAppStore.setState({ zoomedTabId: "t1", terminalAutoRetryCount: { t1: 1 } });
    await render();
    expect(q("zoom-terminal-context-trigger-t1")).toBeNull();
  });

  it.each([
    "settings",
    "log-viewer",
    "editor",
    "connection-editor",
    "tunnel-editor",
    "workspace-editor",
    "network-diagnostic",
    "transfer-view",
    "plugin-detail",
    "agent-error",
    "file-browser",
    "remote-desktop",
  ] as const)("zooming a %s tab renders that surface in the overlay", async (contentType) => {
    await zoom("x1", leaf("left", [tab("x1", "left", contentType)]));
    const overlay = q("zoom-overlay")!;
    const surface = overlay.querySelector(`[data-testid="stub-${contentType}"]`);
    expect(surface, `${contentType} surface in the overlay`).not.toBeNull();
    expect(surface!.getAttribute("data-visible")).toBe("true");
    // The in-panel copy stays mounted but hidden while zoomed.
    const inPanel = q(`panel-content-left`)!.querySelector(`[data-testid="stub-${contentType}"]`);
    expect(inPanel?.getAttribute("data-visible")).toBe("false");
  });
});

// --- In-panel terminal dialogs -------------------------------------------------------

describe("SplitView in-panel terminal dialogs (#5171)", () => {
  async function openTerminalMenu(tabId: string): Promise<void> {
    const trigger = q(`terminal-context-trigger-${tabId}`);
    expect(trigger).not.toBeNull();
    contextMenuOn(trigger!);
    await settle();
  }

  function menuItem(label: RegExp): HTMLElement {
    const el = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) =>
      label.test(m.textContent ?? "")
    );
    expect(el, `menu item ${label}`).toBeDefined();
    return el!;
  }

  beforeEach(async () => {
    seed(twoPanelSplit());
    await render();
  });

  it("rename round-trips for the right-clicked tab", async () => {
    await openTerminalMenu("t3");
    act(() => menuItem(/Rename/).click());
    await settle();
    const input = q("rename-dialog-input") as HTMLInputElement;
    expect(input.value).toBe("Title t3");
    await clickItem("rename-dialog-apply");
    expect(ops.renameTab).toHaveBeenCalledWith("t3", "Title t3");
  });

  it("set colour round-trips for the right-clicked tab", async () => {
    await openTerminalMenu("t3");
    act(() => menuItem(/Set Color/).click());
    await settle();
    await clickItem("color-picker-clear");
    expect(ops.setTabColor).toHaveBeenCalledWith("t3", null);
    expect(q("color-picker-apply")).toBeNull();
  });

  it("toggles horizontal scrolling for the right-clicked tab", async () => {
    await openTerminalMenu("t3");
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
      (m) => /Horizontal Scrolling/.test(m.textContent ?? "")
    );
    expect(item).toBeDefined();
    act(() => item!.click());
    await settle();
    expect(ops.setTabHorizontalScrolling).toHaveBeenCalledWith("t3", true);
  });
});

// --- Panel content-type branches -------------------------------------------------------

describe("SplitView panel surfaces (#5171)", () => {
  it.each([
    "settings",
    "log-viewer",
    "editor",
    "connection-editor",
    "tunnel-editor",
    "workspace-editor",
    "network-diagnostic",
    "transfer-view",
    "plugin-detail",
    "agent-error",
    "file-browser",
    "remote-desktop",
  ] as const)("renders a %s tab's surface, visible only when active", async (contentType) => {
    seed(leaf("left", [tab("x1", "left", contentType), tab("x2", "left", contentType)], "x2"));
    await render();
    const surfaces = q("panel-content-left")!.querySelectorAll(
      `[data-testid="stub-${contentType}"]`
    );
    expect(surfaces).toHaveLength(2);
    expect([...surfaces].map((s) => s.getAttribute("data-visible"))).toEqual(["false", "true"]);
  });

  it("a connecting terminal shows its connection overlay, not the terminal slot", async () => {
    seed(leaf("left", [tab("t1", "left")]));
    useAppStore.setState({ terminalAutoRetryCount: { t1: 2 } });
    await render();
    expect(q("terminal-context-trigger-t1")).toBeNull();
  });

  it("an empty panel in a non-empty window shows the empty state", async () => {
    seed({
      type: "split",
      id: "split-root",
      direction: "vertical",
      children: [leaf("left", [tab("t1", "left")]), leaf("right", [])],
    });
    await render();
    expect(q("split-view-empty")).not.toBeNull();
  });

  it("an empty window renders the empty-window state", async () => {
    seed(leaf("left", []));
    await render();
    expect(document.querySelector(".split-view-groups")).not.toBeNull();
    expect(q("panel-content-left")).toBeNull();
  });
});
