import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TabBar } from "./TabBar";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";

// Render the real Tab so we exercise the actual tablist/tab markup, but stub the
// dnd-kit sortable wrapper (so its own role/tabIndex don't interfere) and the
// terminal registry so the component mounts cleanly in jsdom.
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

function makeTerminalTab(id: string, isActive: boolean): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId: PANEL_ID,
    isActive,
  };
}

let container: HTMLDivElement;
let root: Root;

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

function resetStore() {
  useAppStore.setState({
    terminalSpawnErrors: {},
    terminalDisconnectErrors: {},
    terminalExitedTabs: {},
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetStore();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("TabBar — tablist accessibility (#2071)", () => {
  it("marks the tab strip as a labelled tablist", () => {
    render([makeTerminalTab("t1", true)]);
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    expect(tablist?.getAttribute("aria-label")).toBe("Open sessions");
    expect(tablist?.getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("gives each tab role=tab with aria-selected reflecting the active tab", () => {
    render([makeTerminalTab("t1", true), makeTerminalTab("t2", false)]);
    expect(tabEl("t1").getAttribute("role")).toBe("tab");
    expect(tabEl("t2").getAttribute("role")).toBe("tab");
    expect(tabEl("t1").getAttribute("aria-selected")).toBe("true");
    expect(tabEl("t2").getAttribute("aria-selected")).toBe("false");
  });

  it("uses a roving tab stop: only the active tab is Tab-reachable", () => {
    render([makeTerminalTab("t1", true), makeTerminalTab("t2", false)]);
    expect(tabEl("t1").getAttribute("tabindex")).toBe("0");
    expect(tabEl("t2").getAttribute("tabindex")).toBe("-1");
  });

  it("moves focus to the next/previous tab on Arrow keys", () => {
    render([makeTerminalTab("t1", true), makeTerminalTab("t2", false)]);
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;

    tabEl("t1").focus();
    expect(document.activeElement).toBe(tabEl("t1"));

    act(() => {
      tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.activeElement).toBe(tabEl("t2"));

    act(() => {
      tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(document.activeElement).toBe(tabEl("t1"));
  });

  it("wraps focus and supports Home/End", () => {
    render([
      makeTerminalTab("t1", true),
      makeTerminalTab("t2", false),
      makeTerminalTab("t3", false),
    ]);
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;

    tabEl("t1").focus();
    act(() => {
      tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(document.activeElement).toBe(tabEl("t3"));

    act(() => {
      tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.activeElement).toBe(tabEl("t1"));

    act(() => {
      tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(document.activeElement).toBe(tabEl("t1"));
  });
});
