/**
 * Tab-strip "running automation" badge (#5818 slice 5; was the receiving-macro
 * marker of #3446): every tab a macro or a workflow is typing into, across
 * split panels, carries one distinct, accessible badge with its progress
 * there. It clears as targets drop out and when the run ends, and stops the
 * run on that tab only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TabBar } from "./TabBar";
import { TooltipProvider } from "@/components/ui";
import { useAppStore, type MacroPlaybackState } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { installSessionLifecycleHarness } from "@/test/sessionLifecycleRegionTestHarness";
import { setWorkflowRunViewForTest } from "@/store/workflowRunBridge";
import { flushAsync } from "@/test/flushAsync";

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

installSessionLifecycleHarness();

function term(id: string, panelId: string): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId,
    isActive: false,
  };
}

// Two split panels: left holds a + b, right holds c + d.
const LEFT = [term("a", "left"), term("b", "left")];
const RIGHT = [term("c", "right"), term("d", "right")];

function playback(overrides: Partial<MacroPlaybackState> = {}): MacroPlaybackState {
  return {
    macroId: "m1",
    macroName: "deploy",
    tabId: "a",
    total: 5,
    played: 2,
    targetTabIds: ["a", "c", "d"],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <TabBar panelId="left" tabs={LEFT} />
        <TabBar panelId="right" tabs={RIGHT} />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

function badge(tabId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="tab-automation-badge-${tabId}"]`);
}

function setPlayback(p: MacroPlaybackState | null) {
  act(() => {
    useAppStore.setState({ macroPlayback: p });
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState({ macroPlayback: null, terminalSpawnErrors: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAppStore.setState({ macroPlayback: null });
  setWorkflowRunViewForTest({ run: null, output: null });
});

describe("TabBar — running-automation badge (#5818)", () => {
  it("marks every receiving tab across split panels, and only those", async () => {
    setPlayback(playback());
    await render();
    expect(badge("a")).not.toBeNull();
    expect(badge("c")).not.toBeNull();
    expect(badge("d")).not.toBeNull();
    expect(badge("b")).toBeNull();
  });

  it("names the automation and that tab's own progress", async () => {
    setPlayback(playback({ targetProgress: { a: 4, c: 2, d: 3 } }));
    await render();
    const el = badge("c")!;
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("Running automation “deploy” (40 % typed)");
    expect(el.textContent).toBe("40 %");
    expect(badge("a")?.getAttribute("aria-label")).toBe("Running automation “deploy” (80 % typed)");
  });

  it("clears the badge on a target that dropped out mid-run, keeping the rest", async () => {
    setPlayback(playback());
    await render();
    setPlayback(playback({ targetTabIds: ["a", "d"] }));
    expect(badge("c")).toBeNull();
    expect(badge("a")).not.toBeNull();
    expect(badge("d")).not.toBeNull();
  });

  it("clears every badge when the run ends (finished or canceled)", async () => {
    setPlayback(playback());
    await render();
    setPlayback(null);
    for (const id of ["a", "b", "c", "d"]) expect(badge(id)).toBeNull();
  });

  it("marks the tab of a single-terminal playback too", async () => {
    setPlayback(playback({ tabId: "b", targetTabIds: undefined }));
    await render();
    expect(badge("b")).not.toBeNull();
    for (const id of ["a", "c", "d"]) expect(badge(id)).toBeNull();
  });

  it("shows the same badge for a running workflow, and stops that run", async () => {
    const cancelWorkflowRun = vi.fn();
    useAppStore.setState({ cancelWorkflowRun });
    setWorkflowRunViewForTest({
      run: {
        runId: "r1",
        workflowId: "w1",
        workflowName: "Health check",
        tabId: "d",
        total: 3,
        completed: 1,
      },
      output: null,
    });
    await render();
    expect(badge("d")?.getAttribute("aria-label")).toBe(
      "Running automation “Health check” (step 2 of 3)"
    );
    act(() => badge("d")!.click());
    expect(cancelWorkflowRun).toHaveBeenCalledWith("r1");
  });

  it("stops a macro on the clicked tab only", async () => {
    const cancelMacroPlaybackOnTab = vi.fn();
    useAppStore.setState({ cancelMacroPlaybackOnTab });
    setPlayback(playback());
    await render();
    act(() => badge("c")!.click());
    expect(cancelMacroPlaybackOnTab).toHaveBeenCalledWith("c");
  });

  it("is distinct from the broadcast badge", async () => {
    setPlayback(playback());
    await render();
    expect(badge("a")?.className).toBe("tab__automation-badge");
    expect(container.querySelector('[data-testid="tab-broadcast-badge-a"]')).toBeNull();
  });
});
