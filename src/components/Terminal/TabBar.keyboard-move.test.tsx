/**
 * Keyboard alternatives to dragging a tab (A11Y2-003, #4329).
 *
 * A focused tab moves left/right with Ctrl/Cmd+Shift+ArrowLeft/Right, and its
 * context menu (reachable with Shift+F10 / the Menu key) offers Move Left,
 * Move Right and Move to New Panel. All of them route through the same store
 * actions the drag-and-drop path uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TabBar } from "./TabBar";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  horizontalListSortingStrategy: {},
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("./TerminalRegistry", () => ({
  useTerminalRegistry: () => ({
    clearTerminal: vi.fn(),
    saveTerminalToFile: vi.fn().mockResolvedValue(undefined),
    copyTerminalToClipboard: vi.fn().mockResolvedValue(undefined),
    openTerminalInEditor: vi.fn(),
  }),
}));

vi.mock("./ColorPickerDialog", () => ({ ColorPickerDialog: () => null }));
vi.mock("./RenameDialog", () => ({ RenameDialog: () => null }));

const PANEL_ID = "panel-1";

function makeTab(
  id: string,
  isActive: boolean,
  contentType: TerminalTab["contentType"] = "terminal"
): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "ssh",
    contentType,
    config: { type: "ssh", config: {} },
    panelId: PANEL_ID,
    isActive,
  };
}

let container: HTMLDivElement;
let root: Root;
let reorderTabs: ReturnType<typeof vi.fn>;
let splitPanelWithTab: ReturnType<typeof vi.fn>;

function render(tabs: TerminalTab[]) {
  act(() => {
    root.render(
      <TooltipProvider>
        <TabBar panelId={PANEL_ID} tabs={tabs} />
      </TooltipProvider>
    );
  });
}

function tabEl(tabId: string): HTMLElement {
  return container.querySelector(`[data-testid="tab-${tabId}"]`) as HTMLElement;
}

function keydown(el: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

function openMenu(tabId: string) {
  act(() => {
    tabEl(tabId).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
}

function menuItem(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function select(testId: string) {
  const item = menuItem(testId) as HTMLElement;
  act(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

const THREE = () => [makeTab("t1", true), makeTab("t2", false), makeTab("t3", false)];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  reorderTabs = vi.fn();
  splitPanelWithTab = vi.fn();
  useAppStore.setState({ terminalSpawnErrors: {}, reorderTabs, splitPanelWithTab });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TabBar — move a tab with the keyboard (#4329)", () => {
  it("Ctrl+Shift+ArrowRight moves the focused tab one place right", () => {
    render(THREE());
    tabEl("t2").focus();
    keydown(tabEl("t2"), { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(reorderTabs).toHaveBeenCalledWith(PANEL_ID, 1, 2);
    // Focus does not roam to a neighbour as a plain arrow would.
    expect(document.activeElement).toBe(tabEl("t2"));
  });

  it("Cmd+Shift+ArrowLeft (macOS) moves the focused tab one place left", () => {
    render(THREE());
    tabEl("t2").focus();
    keydown(tabEl("t2"), { key: "ArrowLeft", metaKey: true, shiftKey: true });
    expect(reorderTabs).toHaveBeenCalledWith(PANEL_ID, 1, 0);
  });

  it("does not move past either end", () => {
    render(THREE());
    tabEl("t1").focus();
    keydown(tabEl("t1"), { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    tabEl("t3").focus();
    keydown(tabEl("t3"), { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(reorderTabs).not.toHaveBeenCalled();
  });

  it("a plain arrow still only moves focus", () => {
    render(THREE());
    tabEl("t1").focus();
    keydown(tabEl("t1"), { key: "ArrowRight" });
    expect(reorderTabs).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tabEl("t2"));
  });

  it("context menu offers Move Left / Move Right that reorder the tab", () => {
    render(THREE());
    openMenu("t2");
    select("tab-context-move-right");
    expect(reorderTabs).toHaveBeenCalledWith(PANEL_ID, 1, 2);
    openMenu("t2");
    select("tab-context-move-left");
    expect(reorderTabs).toHaveBeenCalledWith(PANEL_ID, 1, 0);
  });

  it("disables Move Left on the first tab and Move Right on the last", () => {
    render(THREE());
    openMenu("t1");
    expect(menuItem("tab-context-move-left")?.hasAttribute("data-disabled")).toBe(true);
    expect(menuItem("tab-context-move-right")?.hasAttribute("data-disabled")).toBe(false);
  });

  it("Move to New Panel splits the tab out to the right", () => {
    render(THREE());
    openMenu("t3");
    select("tab-context-move-new-panel");
    expect(splitPanelWithTab).toHaveBeenCalledWith("t3", PANEL_ID, PANEL_ID, "right");
  });

  it("hides Move to New Panel when the tab is alone in its panel", () => {
    render([makeTab("t1", true)]);
    openMenu("t1");
    expect(menuItem("tab-context-move-new-panel")).toBeNull();
  });

  it("offers the move commands on non-terminal tabs too", () => {
    render([makeTab("t1", true), makeTab("s1", false, "settings")]);
    openMenu("s1");
    select("tab-context-move-left");
    expect(reorderTabs).toHaveBeenCalledWith(PANEL_ID, 1, 0);
  });
});
