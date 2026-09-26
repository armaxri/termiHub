/**
 * Tab-strip "receiving macro" marker (#3446): while a multi-target macro plays,
 * every receiving tab — across split panels — carries a distinct, accessible
 * badge that clears as targets drop out and when the run ends.
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
    timingMode: "real-time",
    total: 5,
    played: 2,
    targetTabIds: ["a", "c", "d"],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <TooltipProvider>
        <TabBar panelId="left" tabs={LEFT} />
        <TabBar panelId="right" tabs={RIGHT} />
      </TooltipProvider>
    );
  });
}

function badge(tabId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="tab-macro-badge-${tabId}"]`);
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
});

describe("TabBar — receiving-macro marker (#3446)", () => {
  it("marks every receiving tab across split panels, and only those", () => {
    setPlayback(playback());
    render();
    expect(badge("a")).not.toBeNull();
    expect(badge("c")).not.toBeNull();
    expect(badge("d")).not.toBeNull();
    expect(badge("b")).toBeNull();
  });

  it("exposes the macro name and progress as the accessible label and tooltip", () => {
    setPlayback(playback());
    render();
    const el = badge("c")!;
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe('Receiving macro "deploy" (2/5 steps)');
    expect(el.getAttribute("title")).toBe('Receiving macro "deploy" (2/5 steps)');
  });

  it("updates the progress as steps are played", () => {
    setPlayback(playback());
    render();
    setPlayback(playback({ played: 4 }));
    expect(badge("a")?.getAttribute("aria-label")).toBe('Receiving macro "deploy" (4/5 steps)');
  });

  it("clears the marker on a target that dropped out mid-run, keeping the rest", () => {
    setPlayback(playback());
    render();
    setPlayback(playback({ targetTabIds: ["a", "d"] }));
    expect(badge("c")).toBeNull();
    expect(badge("a")).not.toBeNull();
    expect(badge("d")).not.toBeNull();
  });

  it("clears every marker when the run ends (finished or cancelled)", () => {
    setPlayback(playback());
    render();
    setPlayback(null);
    for (const id of ["a", "b", "c", "d"]) expect(badge(id)).toBeNull();
  });

  it("does not mark the tab of a single-terminal playback", () => {
    setPlayback(playback({ targetTabIds: undefined }));
    render();
    for (const id of ["a", "b", "c", "d"]) expect(badge(id)).toBeNull();
  });

  it("is distinct from the broadcast badge", () => {
    setPlayback(playback());
    render();
    expect(badge("a")?.className).toBe("tab__macro-badge");
    expect(container.querySelector('[data-testid="tab-broadcast-badge-a"]')).toBeNull();
  });
});
