/**
 * Tablist arrow + Enter/Space selection in the TabBar (#5182, UX-008).
 *
 * Arrow keys move focus only (manual activation); Enter/Space on the focused
 * tab selects it through the store and hands focus to a terminal tab's content.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TabBar } from "./TabBar";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import type { TerminalTab } from "@/types/terminal";

const focusTerminal = vi.fn<(tabId: string) => void>();

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
    focusTerminal,
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
let setActiveTab: ReturnType<typeof vi.fn<(tabId: string, panelId: string) => void>>;

function render(tabs: TerminalTab[]) {
  act(() => {
    root.render(
      <TooltipProvider>
        <TabBar panelId={PANEL_ID} tabs={tabs} />
      </TooltipProvider>
    );
  });
}

const tabEl = (id: string) => container.querySelector(`[data-testid="tab-${id}"]`) as HTMLElement;

function keydown(el: HTMLElement, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  setActiveTab = vi.fn<(tabId: string, panelId: string) => void>();
  focusTerminal.mockReset();
  useAppStore.setState({ terminalSpawnErrors: {}, setActiveTab });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TabBar — select a tab with the keyboard (#5182)", () => {
  it("arrow moves focus without selecting; Enter then selects the focused tab", () => {
    render([makeTab("t1", true), makeTab("t2", false), makeTab("t3", false)]);
    tabEl("t1").focus();
    keydown(tabEl("t1"), "ArrowRight");
    expect(document.activeElement).toBe(tabEl("t2"));
    expect(setActiveTab).not.toHaveBeenCalled();

    keydown(tabEl("t2"), "Enter");
    expect(setActiveTab).toHaveBeenCalledWith("t2", PANEL_ID);
  });

  it("Space selects the focused tab", () => {
    render([makeTab("t1", true), makeTab("t2", false)]);
    tabEl("t1").focus();
    keydown(tabEl("t1"), "End");
    keydown(tabEl("t2"), " ");
    expect(setActiveTab).toHaveBeenCalledWith("t2", PANEL_ID);
  });

  it("moves focus into an activated terminal tab's content", () => {
    render([makeTab("t1", true), makeTab("t2", false)]);
    keydown(tabEl("t1"), "Enter");
    expect(focusTerminal).toHaveBeenCalledWith("t1");
  });

  it("leaves focus on a non-terminal tab (Tab then moves into its panel)", () => {
    render([makeTab("t1", true), makeTab("s1", false, "settings")]);
    keydown(tabEl("s1"), "Enter");
    expect(setActiveTab).toHaveBeenCalledWith("s1", PANEL_ID);
    expect(focusTerminal).not.toHaveBeenCalled();
  });

  it("mouse click still selects without moving focus into the terminal", () => {
    render([makeTab("t1", true), makeTab("t2", false)]);
    act(() => tabEl("t2").click());
    expect(setActiveTab).toHaveBeenCalledWith("t2", PANEL_ID);
    expect(focusTerminal).not.toHaveBeenCalled();
  });
});
