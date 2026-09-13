import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TabBar } from "./TabBar";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { checkA11y } from "@/test/axe";
import {
  connecting,
  disconnected,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";

// Render the real Tab so we exercise the actual status-indicator markup, but stub
// the dnd-kit sortable wrapper and the terminal registry so it mounts in jsdom.
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

const harness = installSessionLifecycleHarness();

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

function dotFor(tabId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="tab-state-dot-${tabId}"]`);
}

/** The status icon's shape identity — the lucide svg's class (e.g. `lucide-circle`). */
function iconShapeFor(tabId: string): string | null {
  return dotFor(tabId)?.querySelector("svg")?.getAttribute("class") ?? null;
}

function resetStore() {
  useAppStore.setState({ terminalSpawnErrors: {} });
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

describe("TabBar — non-colour status indicator (UX-014)", () => {
  it("renders an icon shape (not just a coloured dot) for the connected state", () => {
    render([makeTerminalTab("t1", true)]);
    const shape = iconShapeFor("t1");
    expect(shape).not.toBeNull();
    // A real svg icon is present, so status is conveyed by shape, not colour alone.
    expect(dotFor("t1")?.querySelector("svg")).not.toBeNull();
  });

  it("uses a distinct shape for each connection status", async () => {
    render([
      makeTerminalTab("connected", true),
      makeTerminalTab("connecting", false),
      makeTerminalTab("failed", false),
      makeTerminalTab("disconnected", false),
    ]);
    // Drive each tab into its state.
    harness.transport.setSession("connecting", connecting());
    harness.transport.setSession("disconnected", disconnected());
    act(() => {
      useAppStore.setState({ terminalSpawnErrors: { failed: "boom" } });
    });
    await flushSessionRegion();

    const shapes = [
      iconShapeFor("connected"),
      iconShapeFor("connecting"),
      iconShapeFor("failed"),
      iconShapeFor("disconnected"),
    ];
    // Every state resolved to an icon…
    expect(shapes.every((s) => typeof s === "string" && s.length > 0)).toBe(true);
    // …and every icon is a distinct silhouette (no two states share a shape).
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("marks the connecting spinner as essential motion so reduced-motion pulses instead of freezing", async () => {
    harness.transport.setSession("t1", connecting());
    render([makeTerminalTab("t1", true)]);
    await flushSessionRegion();
    const icon = dotFor("t1")?.querySelector("svg");
    expect(icon?.getAttribute("class")).toContain("motion-essential-spinner");
  });

  it("keeps a persistent accessible name on the indicator (legible without hover)", () => {
    render([makeTerminalTab("t1", true)]);
    const dot = dotFor("t1");
    expect(dot?.getAttribute("role")).toBe("img");
    expect(dot?.getAttribute("aria-label")).toBe("Connected");
    // The inner icon is decorative — its meaning is carried by the labelled wrapper.
    expect(dot?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("has no accessibility violations on the status indicator itself", async () => {
    // Scope the audit to the indicator: the surrounding tab strip has a separate,
    // pre-existing `nested-interactive` structure (role=tab + close button) that is
    // out of scope for UX-014.
    render([makeTerminalTab("failed", true)]);
    act(() => {
      useAppStore.setState({ terminalSpawnErrors: { failed: "boom" } });
    });
    const dot = dotFor("failed");
    expect(dot).not.toBeNull();
    expect(await checkA11y(dot as HTMLElement)).toHaveNoViolations();
  });
});
