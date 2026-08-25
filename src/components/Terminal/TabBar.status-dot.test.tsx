import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TabBar } from "./TabBar";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import {
  connecting,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";

// Render the *real* Tab so we exercise the actual state-dot markup, but stub out
// the dnd-kit sortable wrapper and the terminal registry so the component mounts
// cleanly in jsdom.
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

// The connecting/reconnecting status the dot reads is sourced purely from the
// projected `session-lifecycle` region (#2205), so seed the region for those
// states. The failed/disconnected dots still read their `appStore` slices
// (`terminalSpawnErrors` / `terminalExitedTabs`) and leave the region empty.
const harness = installSessionLifecycleHarness();

function makeTerminalTab(id: string, isActive: boolean): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    // Concrete connection type — NOT "remote" (the old dead-code path).
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

/** Return the state-dot element for a given tab id, or null. */
function dotFor(tabId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="tab-state-dot-${tabId}"]`);
}

function resetStore() {
  useAppStore.setState({
    terminalConnecting: {},
    terminalReconnectingTabs: {},
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

describe("TabBar — per-tab connection status dot", () => {
  it("renders a 'connected' dot for a terminal tab with no lifecycle flags", () => {
    render([makeTerminalTab("t1", true)]);
    const dot = dotFor("t1");
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain("tab__state-dot--connected");
  });

  it("renders a 'connecting' dot while the terminal is connecting", async () => {
    harness.transport.setSession("t1", connecting());
    render([makeTerminalTab("t1", true)]);
    await flushSessionRegion();
    expect(dotFor("t1")?.className).toContain("tab__state-dot--connecting");
  });

  it("renders a 'failed' dot when the terminal has a spawn error", () => {
    render([makeTerminalTab("t1", true)]);
    act(() => {
      useAppStore.setState({ terminalSpawnErrors: { t1: "boom" } });
    });
    expect(dotFor("t1")?.className).toContain("tab__state-dot--failed");
  });

  it("renders a 'disconnected' dot when the terminal session has exited", () => {
    render([makeTerminalTab("t1", true)]);
    act(() => {
      useAppStore.setState({ terminalExitedTabs: { t1: true } });
    });
    expect(dotFor("t1")?.className).toContain("tab__state-dot--disconnected");
  });

  it("reflects state changes on a background (inactive) tab without focusing it", () => {
    // t1 is active/focused, t2 is a background tab.
    render([makeTerminalTab("t1", true), makeTerminalTab("t2", false)]);

    // Background tab starts connected.
    expect(dotFor("t2")?.className).toContain("tab__state-dot--connected");

    // Its session drops while it stays in the background.
    act(() => {
      useAppStore.setState({ terminalExitedTabs: { t2: true } });
    });

    expect(dotFor("t2")?.className).toContain("tab__state-dot--disconnected");
    // The focused tab is unaffected.
    expect(dotFor("t1")?.className).toContain("tab__state-dot--connected");
  });
});
